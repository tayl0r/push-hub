# push-hub Design Spec

**Date:** 2026-07-18
**Scope:** A self-hosted, multi-tenant push service that owns the `user → device tokens` mapping and sends by user id, using the [`@tsteil/push-service`](https://github.com/tayl0r/push-service) library as its APNs/FCM engine. Serves several apps (team-comm, substitute, setpiece). This spec covers building + deploying the service; each app adopting it is a separate per-app follow-up.

---

## Overview

Three apps need push notifications. Rather than each one storing device tokens, holding APNs/FCM credentials, and re-implementing dead-token cleanup, `push-hub` centralizes all of that behind two endpoints:

- **Register** a device: an app tells push-hub `userId → token` (+ platform).
- **Send** to a user: an app calls push-hub with a `userId` (or list); push-hub resolves every device that user has registered, sends through the engine, and deletes any tokens the providers report dead — the app never sees a token lifecycle.

push-hub is **stateful** (it owns the token store) and **multi-tenant** (each app is isolated by its own API key, credentials, and token namespace). The actual talking-to-Apple/Google is delegated to the `@tsteil/push-service` engine, which already handles HTTP/2 APNs, FCM v1, retries, and default-safe dead-token classification — so push-hub is a thin, well-tested store + fan-out + auth layer on top of a proven core.

**Why a service (vs. each app using the engine directly):** with three apps it is the right shared boundary — token storage, registration, cleanup, and credential management get written and operated **once**, and every app inherits correct-by-default behavior instead of three copies that can each drift. (For a single app the in-process library is simpler; three is the concrete demand that flips it.)

**Message shape** mirrors Expo's push message (`title` / `body` / `data` / `badge` / `sound` / `priority`) so notification-building code stays familiar — but the **targeting is by `userId`, not by token**. Expo's API is send-by-token and stateless about users (the caller owns the mapping); copying that would defeat the point, so push-hub keeps Expo's payload feel while owning the tokens. `badge` sets the iOS app-icon count (APNs only — Android has no equivalent notification field); `sound` applies to both platforms; `priority` defaults to `high` (immediate alert) and may be set to `normal`. Carrying these fields requires the engine to support them: a small **v1.1.0** bump re-adds `badge`/`sound`/`priority` passthrough to `@tsteil/push-service` (Task 0 of the plan).

---

## Stack

| Concern | Choice | Rationale |
|---|---|---|
| Sending engine | [`@tsteil/push-service`](https://github.com/tayl0r/push-service) **v1.1.0** (git dep) | Direct APNs + FCM, default-safe classification, retries. v1.1.0 adds `badge`/`sound`/`priority` passthrough (Task 0). |
| HTTP framework | Fastify | Lightweight, fast, matches the other apps' stack. |
| DB / ORM | PostgreSQL + Drizzle | Shared VPS Postgres; Drizzle matches the house pattern. |
| Language / build | TypeScript → ESM, Node ≥ 22 | Same baseline as the engine + apps. |
| Tests | vitest | House runner. |
| Deploy | Docker + GitHub Actions → VPS | The existing `DEPLOY.md` pattern (own dir, own DB, dev + prod). |

---

## Architecture

```
   app (team-comm / substitute / setpiece)
        │  Authorization: Bearer <app API key>
        │
        ├── POST /v1/tokens   { userId, token, platform }        (register a device)
        └── POST /v1/send     { to: userId|userId[], ...message } (send by user)
                    │
        ┌───────────▼──────────────────────────────────────────┐
        │ push-hub                                              │
        │  1. resolve API key → app (slug + creds)              │
        │  2. look up push_tokens WHERE app=? AND userId IN ?   │  ◄── owns the 1→many store
        │  3. engine.send({ tokens: [{token,provider,ref}], … })│
        │  4. delete rows where result.status === 'invalid'     │  ◄── server-side cleanup
        │  5. return Expo-shaped tickets                        │
        └───────────┬──────────────────────────────────────────┘
                    │   per-app @tsteil/push-service engine (APNs + FCM)
                    ▼
               APNs / FCM
```

**Two layers, cleanly split:**
- **Engine** (`@tsteil/push-service`, unchanged, public) — stateless sending + classification.
- **Service** (`push-hub`, this repo) — auth, the token store, user→token resolution, fan-out, and cleanup.

**One engine instance per app.** Each app has its own APNs/FCM credentials, so push-hub builds one `createPushService(...)` per configured app at startup and picks the right one from the request's API key.

---

## Multi-tenancy & auth

- Each app is a **tenant** identified by a `slug` (e.g. `team-comm`).
- Every request carries `Authorization: Bearer <key>`. push-hub resolves the key → tenant. All token rows and sends are scoped to that tenant; an app can never see or push another app's users.
- **API keys are stored hashed** (SHA-256) in config; the incoming key is hashed and compared. Keys are opaque random strings (e.g. `phk_<random>`), provisioned out-of-band.
- Unknown/again-hashed-mismatch key → `401`. A valid key whose tenant has no engine configured for the target platform → the affected recipients come back as `error` tickets, not a request failure.

### Tenant configuration (from env)

The service loads a per-tenant config at startup from a single JSON env var (so secrets stay out of code and out of the DB):

```
PUSH_HUB_TENANTS='[
  {
    "slug": "team-comm",
    "apiKeyHash": "<sha256 of the app key>",
    "apns": { "keyId": "...", "teamId": "...", "bundleId": "com.tsteil.teamcomm",
              "signingKey": "<base64 .p8>", "production": true },
    "fcm":  { "projectId": "...", "clientEmail": "...", "privateKey": "..." }
  },
  { "slug": "substitute", ... },
  { "slug": "setpiece",   ... }
]'
```

`apns` and `fcm` are each optional per tenant (an app can be iOS-only) but **at least one is required** — a tenant configuring neither is rejected at startup. The engine's own validation throws at startup if a present block is *structurally* malformed (missing fields, bad base64 `.p8`) — so a broken tenant config fails the deploy, not the first send. Credential *correctness* (right keyId, unrevoked key, right projectId) can't be checked at boot; a structurally-valid-but-wrong credential surfaces as a `500` on first send and is caught by the end-to-end smoke test in deploy (see dead-token lifecycle).

---

## Data model

One table. Tenant + user + token, unique **per tenant** on `(appSlug, token)` — a device registers once per app, and re-registering reassigns it to that app's current user. Scoping uniqueness to the tenant (rather than making `token` globally unique) means one app can never evict or claim another app's row, even in the theoretical case of a shared token string — isolation is structural, not dependent on Apple/Google never colliding tokens across apps.

```ts
pushTokens = pgTable('push_tokens', {
  id:        uuid('id').primaryKey().defaultRandom(),
  appSlug:   text('app_slug').notNull(),                     // tenant
  userId:    text('user_id').notNull(),                      // opaque — the app's own user id
  token:     text('token').notNull(),                        // native APNs/FCM token
  platform:  text('platform', { enum: ['ios','android'] }).notNull(),
  createdAt: timestamp(...).defaultNow().notNull(),
  lastSeenAt: timestamp(...),
}, (t) => [
  unique('push_tokens_app_token_unique').on(t.appSlug, t.token), // one (app,token) → one user (reassigned on conflict); tenant-scoped so isolation is structural
  index('push_tokens_app_user_idx').on(t.appSlug, t.userId),     // the send lookup
])
```

- **`userId` is opaque** — push-hub never interprets it; it's whatever id the app uses. No coupling to any app's identity model.
- **1→many** is `(appSlug, userId)` → many rows, exactly as required for multi-device.
- **`provider` is derived** from `platform` at send time (`ios → apns`, `android → fcm`); not stored (redundant, and would need a client change to supply). This 1:1 mapping assumes each app delivers iOS via **direct APNs** (not Firebase-for-iOS); a future Firebase-iOS tenant would need this seam widened — out of scope until a concrete consumer requires it.

---

## API

All endpoints are under `/v1`, require `Authorization: Bearer <key>`, and are scoped to the resolved tenant.

### `POST /v1/tokens` — register a device

```jsonc
// request
{ "userId": "u_123", "token": "<native-token>", "platform": "ios" }
// response 200
{ "ok": true }
```
Upserts on `(appSlug, token)`. If that device is already registered for this app (same device re-registering, possibly under a new user), its `userId`/`lastSeenAt` are reassigned — so within an app a device only ever maps to one current user (prevents cross-user delivery). Because the key is tenant-scoped, the same token string under a different app is a separate row, never an eviction of another tenant's registration.

### `DELETE /v1/tokens` — unregister (e.g. sign-out)

```jsonc
// request
{ "token": "<native-token>" }        // scoped to tenant
// response 200
{ "ok": true, "deleted": 1 }
```

### `POST /v1/send` — send to user(s)

```jsonc
// request — Expo-flavored message fields, but `to` is user id(s)
{
  "to": "u_123",                       // or ["u_123","u_456"]
  "title": "New message",
  "body": "Alice: see you at 3pm",
  "data": { "type": "dm", "conversationId": "c1" },   // Record<string,string>
  "badge": 3,                          // optional — iOS app-icon badge
  "sound": "default",                  // optional — iOS + Android
  "priority": "high"                   // optional — 'high' (default) | 'normal'
}
// response 200 — one ticket per device the message was attempted to
{
  "data": [
    { "userId": "u_123", "status": "ok" },
    { "userId": "u_123", "status": "error", "error": "invalid" },   // this device's token was dead (already removed)
    { "userId": "u_456", "status": "ok" }
  ]
}
```

- `to` expands to every registered device for those users in this tenant.
- Each ticket is Expo-shaped (`status: 'ok' | 'error'`), reporting a **per-device** outcome but keyed only by `userId`: a multi-device user yields one ticket per device, all carrying the same `userId` — tickets are a per-user aggregate and do not identify the individual device. On failure, `error` carries the engine's reason string (e.g. `Unregistered`, `provider not configured`). A `userId` with no registered devices simply contributes no tickets.
- **No separate receipts endpoint.** Expo needs one because its delivery result is async; the engine talks to APNs/FCM directly and gets the dead-token verdict *in the send response*, so push-hub resolves everything in the single call.

---

## Dead-token lifecycle (server-side, correct-by-default)

On every `/send`, push-hub passes `ref = push_tokens.id` into the engine, then **deletes the rows the engine reports `invalid`** in the same request. Apps never learn about, or have to act on, dead tokens. `failed` (transient/unknown) results are left in place and logged — never deleted. Engine `throw`s (bad credentials for that tenant) are caught, reported, and surfaced as `500` for that send — they mean the tenant is misconfigured, not that a token is bad. This throw is **all-or-nothing across providers**: because the engine sends APNs and FCM together, a config-class failure on one provider (e.g. a revoked APNs key) rejects the whole request, so recipients on the *healthy* provider get no delivery and no ticket until the bad credential is fixed. This is deliberate fail-loud — it's why credentials are validated end-to-end at deploy.

---

## Deployment & Environments

Follows `DEPLOY.md`:
- **Two environments** — `push-hub` (prod) and `push-hub-dev` (dev), each its own dir + `.env` on the VPS, each its own DB (`pushhub` / `pushhub_dev`) on shared Postgres.
- **Reachability:** the `/send` endpoint can push to any user, so it is **not** exposed publicly by default — apps on the shared VPS reach it over the internal Docker network (service `push-hub:3000`). A public route (`push.<your-domain>`) is added only if an off-VPS app must call it, and it stays behind the per-app API keys regardless.
- **Migrations** run as the existing pre-deploy `docker run … migrate` step.
- **Secrets** (`PUSH_HUB_TENANTS` with all tenants' creds + key hashes) live only in the server `.env`. The repo is public but holds no secrets; `.env.example` carries an empty placeholder + the shape.
- **Error tracking** via GlitchTip (`push-hub` project), `SENTRY_ENVIRONMENT` per env.

---

## Testing

- **Token registry** (unit + db): register upserts; re-register under a new user reassigns; delete scopes to tenant; cross-tenant isolation (app A cannot see app B's tokens).
- **Send** (unit, engine mocked): `to` expands to all a user's devices; `ref` → correct row; `invalid` results delete exactly those rows and nothing else; `failed` results delete nothing; an engine `throw` becomes a reported `500`; multi-user `to` fans out correctly; a user with no devices yields no tickets.
- **Auth**: missing/blank/wrong key → `401`; valid key resolves the right tenant + engine.
- **Config loader**: parses `PUSH_HUB_TENANTS`; a malformed tenant block fails startup loudly.

---

## What's Not In Scope

- **App adoption / migration.** Wiring team-comm, substitute, and setpiece to call push-hub (incl. migrating team-comm's existing `push_tokens` data) is a per-app follow-up, documented separately.
- **Async receipts / delivery analytics.** The engine's synchronous verdict is the outcome; no receipt-polling API.
- **Web push, scheduling, templating, segments, in-app inbox.** push-hub is device push by user id — not a full notification platform. Add against concrete demand.
- **A management UI / self-serve tenant onboarding.** Tenants are provisioned via the env config.
