# push-hub's built-in push engine (`src/engine/`)

This guide walks a backend + mobile app through adopting the library end to end:
provision credentials → register native device tokens on the client → store them →
send from the server → delete dead tokens. For the API/type reference and the full
config table, see the [README](../README.md); this doc is the workflow around it.

> **TL;DR of the moving parts**
> 1. You hold the credentials (Apple `.p8`, Firebase service account) — not a relay.
> 2. Your app registers **native** device tokens (not Expo tokens).
> 3. Your server stores each token with its platform, derives `provider`, and calls `send()`.
> 4. You delete tokens the library reports `invalid`, keyed by the `ref` you passed in.

---

## The end-to-end flow

```
┌────────────┐  native token   ┌──────────────┐   {token, provider, ref}   ┌──────────────┐
│  mobile    │ ──────────────► │  your API    │ ─────────────────────────► │ push-service │
│  client    │  POST /tokens   │  (stores it) │      push.send(...)        │  APNs / FCM  │
└────────────┘                 └──────────────┘ ◄───────────────────────── └──────────────┘
      ▲                              │  SendResult[]  (delivered/failed/invalid, echoing ref)
      │ getDevicePushTokenAsync()    ▼
      │                         delete rows where status === 'invalid' (by ref)
```

The library owns exactly one step (talk to APNs/FCM and classify the response). Everything
else — token storage, provider routing, deletion — stays in your app, which is what keeps
the library reusable.

---

## 1. Provision credentials (one-time, manual)

### APNs (iOS)
1. Apple Developer portal → **Keys** → create a key with **Apple Push Notifications service (APNs)** enabled.
2. Download the `.p8`. Record the **Key ID** and your **Team ID**.
3. Base64-encode it for env storage: `base64 -i AuthKey_XXXX.p8`.

### FCM (Android)
1. [Firebase console](https://console.firebase.google.com) → create/choose a project → add an **Android app** with your package name.
2. Download `google-services.json` (used by the *client* build, step 2).
3. Project settings → **Service accounts** → **Generate new private key**. From that JSON, record `project_id`, `client_email`, `private_key`.

You do **not** register these with any third party — they go straight into your server's env (step 5).

---

## 2. Client: register native device tokens

The library sends to raw APNs/FCM tokens, so the client must produce those — **not** Expo push tokens.

### Expo / React Native
```ts
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

async function registerPushToken(apiFetch: Fetch) {
  const { status } = await Notifications.requestPermissionsAsync()
  if (status !== 'granted') return

  // NATIVE token: hex APNs token on iOS, FCM registration token on Android.
  // (Do NOT use getExpoPushTokenAsync — that returns an Expo token this library can't send to.)
  const { data: token } = await Notifications.getDevicePushTokenAsync()

  await apiFetch('/me/push-tokens', {
    method: 'POST',
    body: JSON.stringify({ token, platform: Platform.OS }), // 'ios' | 'android'
  })
}
```

**Native prerequisites** (needed for `getDevicePushTokenAsync` to return a token):
- **iOS**: the Push Notifications capability / `aps-environment` entitlement. With `expo-notifications` installed this is handled by the build.
- **Android**: `google-services.json` (from step 1) referenced in your app config (`android.googleServicesFile` in `app.json` for Expo). Without it, FCM never issues a token.

Bare React Native (no Expo): use `@react-native-firebase/messaging` `getToken()` on Android and the APNs device token from `PushNotificationIOS`/native on iOS. The server side is identical.

---

## 3. Server: store tokens

Minimal storage — one row per device installation. A suggested schema (Postgres/Drizzle shown, adapt freely):

```ts
pushTokens = {
  id: uuid primary key default random,
  userId: fk → users,
  token: text not null unique,          // the native token; unique so a device maps to one row
  platform: text not null,              // 'ios' | 'android'
  createdAt, lastSeenAt,
}
```

Registration route — upsert on `token`, reassigning to the current user if the device changed hands:

```ts
app.post('/me/push-tokens', async (req) => {
  const { token, platform } = req.body as { token: string; platform: 'ios' | 'android' }
  await db.insert(pushTokens)
    .values({ userId: req.userId, token, platform, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: pushTokens.token, set: { userId: req.userId, platform, lastSeenAt: new Date() } })
})
```

You do **not** store a `provider` column — it is a pure function of `platform` (see next step). Storing it would be redundant, and requiring the client to send it creates a forced-upgrade cliff.

---

## 4. Server: send

This is the whole integration. Build one `send()` call site (a shared choke point), so provider routing, deletion, and error reporting live in exactly one place.

```ts
// push-hub imports the engine internally; src/registry.ts is the only importer.
import { createPushService, type PushTarget } from './engine/index.js'
import { push as pushConfig } from './push-config' // your env → config (step 5)

const push = createPushService(pushConfig)

async function sendPush(userIds: string[], notification: { title: string; body: string; data: Record<string, string> }) {
  // 1. Load candidate tokens for the recipients.
  const rows = await db.select({ id: pushTokens.id, token: pushTokens.token, platform: pushTokens.platform })
    .from(pushTokens)
    .where(inArray(pushTokens.userId, userIds))

  // 2. Map rows → targets. Derive provider from platform; ref = your row id.
  const tokens: PushTarget[] = rows.map(r => ({
    token: r.token,
    provider: r.platform === 'ios' ? 'apns' : 'fcm',
    ref: r.id,
  }))
  if (tokens.length === 0) return

  // 3. Send — catch config-level throws (bad .p8 / service account) loudly.
  let results
  try {
    results = await push.send({ tokens, notification })
  } catch (err) {
    reportToErrorTracker(err) // deploy misconfig — fix creds, do NOT delete tokens
    return
  }

  // 4. Delete dead tokens by ref; report (don't delete) transient/unknown failures.
  const deadIds = results.filter(r => r.status === 'invalid' && r.ref).map(r => r.ref!)
  if (deadIds.length) await db.delete(pushTokens).where(inArray(pushTokens.id, deadIds))

  const failed = results.filter(r => r.status === 'failed')
  if (failed.length) reportToErrorTracker(new Error(`push: ${failed.length}/${results.length} failed`), { failed })
}
```

The three rules that make this correct-by-default:
- **`invalid` → delete** (keyed by `ref`, never by re-matching the token string).
- **`failed` → keep + log** (transient or unknown — deleting would be wrong).
- **thrown error → report, don't touch tokens** (the whole integration is misconfigured, not one token).

If your sends are fire-and-forget (`sendPush(...).catch(...)`), remember the thrown config error is swallowed there — that's exactly why the reporting lives *inside* `sendPush`, not at the call sites.

---

## 5. Configure providers from env

Gate each provider on the presence of its secret so an environment without credentials just
runs without that provider (lets you ship iOS first, add Android later, with no code change):

```ts
// push-config.ts
export const push = {
  apns: process.env.APNS_SIGNING_KEY ? {
    keyId: process.env.APNS_KEY_ID!, teamId: process.env.APNS_TEAM_ID!,
    bundleId: process.env.APNS_BUNDLE_ID!, signingKey: process.env.APNS_SIGNING_KEY,
    production: process.env.APNS_PRODUCTION === 'true',
  } : undefined,
  fcm: process.env.FCM_PRIVATE_KEY ? {
    projectId: process.env.FCM_PROJECT_ID!, clientEmail: process.env.FCM_CLIENT_EMAIL!,
    privateKey: process.env.FCM_PRIVATE_KEY,
  } : undefined,
}
```

See the [README config reference](../README.md#configuration-reference) for the full field/env table. Pass the **raw** env values — the library base64-decodes the `.p8` and un-escapes the FCM key's `\n` for you.

---

## 6. Deployment notes

- **Secrets** live only in the server environment (and CI secrets) — never commit them. `.env.example` should carry empty placeholders.
- **`APNS_PRODUCTION`** is dictated by how the app is *built*, not the server: production-signed builds (TestFlight / App Store / EAS) mint tokens valid only against `api.push.apple.com` → set `true`; Xcode debug builds mint sandbox tokens → set `false`. The library does not auto-detect. Match it to your distribution and set the **same value in every server environment** (dev and prod) if they all serve the same app build.
- **Same credentials across dev/prod** is normal when there is one iOS app + one Firebase project — native tokens are portable across your server environments.
- **Structural misconfig fails fast**: a malformed present-provider block throws at `createPushService(...)` (module load), so a broken deploy surfaces at boot, not silently on the first send.

---

## Migrating from `expo-server-sdk`

The two are **not** drop-in compatible. Expo hid the platform, held your credentials, and used
a two-phase ticket/receipt model; this library is explicit about all three. The mapping:

| Concern | `expo-server-sdk` | push-hub engine (`src/engine`) |
|---|---|---|
| Client token | `getExpoPushTokenAsync({ projectId })` → `ExponentPushToken[…]` | `getDevicePushTokenAsync()` → native APNs/FCM token |
| Server credentials | none (Expo holds APNs/FCM keys) | you supply APNs `.p8` + FCM service account |
| Create client | `new Expo()` | `createPushService({ apns?, fcm? })` |
| Validate token | `Expo.isExpoPushToken(t)` | none — `provider` (from `platform`) determines routing |
| Message shape | `{ to, title, body, data, sound, badge, priority }` | `notification: { title, body, data }` + per-target `{ token, provider, ref }` |
| Batching | `chunkPushNotifications()` + loop | automatic (bounded concurrency internally) |
| Send | `sendPushNotificationsAsync(chunk)` → tickets | `send({ tokens, notification })` → `SendResult[]` |
| Dead-token signal | ticket/receipt `details.error === 'DeviceNotRegistered'` — often only in **receipts** you poll later | `result.status === 'invalid'` — returned **synchronously** from the same `send()` |
| Retry | you implement | built-in bounded transient retry |
| Result correlation | tickets index-aligned to messages | `ref` echoed on each result |
| Priority | `priority: 'high'` per message | always high-priority alert (built in) |

**What actually changes when you migrate:**
1. **Client**: swap `getExpoPushTokenAsync` → `getDevicePushTokenAsync`; add `google-services.json` (Android) and confirm the iOS push entitlement. Existing Expo tokens become unusable — devices re-register native tokens on the next launch of the new build, so plan a one-time cleanup of old Expo-format tokens (e.g. `DELETE FROM push_tokens WHERE token LIKE 'ExponentPushToken%'`).
2. **Server**: provision the `.p8` + Firebase service account; replace the `new Expo()` / chunk / `sendPushNotificationsAsync` / receipt-polling code with the single `send()` call site in step 4.
3. **No more receipt polling**: the dead-token signal you previously fished out of receipts arrives directly as `status: 'invalid'`.

---

## Common pitfalls

- **Sending an Expo token to this library** → APNs `BadDeviceToken` / FCM `INVALID_ARGUMENT`. iOS ones self-clean (`invalid` → deleted); FCM `INVALID_ARGUMENT` is (correctly) `failed`, not `invalid`, so it won't self-delete — do the one-time `ExponentPushToken%` cleanup above.
- **`data` must be `Record<string,string>`** — FCM rejects non-string values. Stringify before passing.
- **Wrong `APNS_PRODUCTION`** → every APNs send fails with `BadDeviceToken` (a sandbox token against the production host, or vice-versa). This is the #1 "nothing delivers on iOS" cause.
- **Android returns no token** → missing/incorrect `google-services.json` in the client build.
- **Deleting on `failed`** → don't. Only `invalid` means the token is dead.
