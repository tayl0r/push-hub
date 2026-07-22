# push-hub

A self-hosted, multi-tenant push-notification service. It owns the `user → device
tokens` mapping and sends **by user id**, using its built-in APNs/FCM engine
(`src/engine/`).

Instead of every app storing its own device tokens, holding APNs/FCM credentials, and
re-implementing dead-token cleanup, push-hub centralizes that behind two endpoints:

- **Register** a device — an app tells push-hub `userId → token` (+ platform).
- **Send** to a user — an app calls push-hub with a `userId` (or list); push-hub
  resolves every device that user has registered, sends through the engine, and
  deletes any tokens the providers report dead. The app never sees a token lifecycle.

Each app is a **tenant**, isolated by its own API key, credentials, and token
namespace — one app can never see or push another app's users.

## API

All endpoints are under `/v1`, require `Authorization: Bearer <app key>`, and are
scoped to the tenant that key resolves to.

### `POST /v1/tokens` — register a device

```jsonc
// request
{ "userId": "u_123", "token": "<native-device-token>", "platform": "ios" } // or "android"
// response 200
{ "ok": true }
```

Upserts on `(tenant, token)`. If that device is already registered for this tenant
(e.g. it's re-registering under a new signed-in user), its `userId` is reassigned —
so within a tenant a device only ever maps to one current user.

### `DELETE /v1/tokens` — unregister a device (e.g. on sign-out)

```jsonc
// request
{ "token": "<native-device-token>" }
// response 200
{ "ok": true, "deleted": 1 }
```

### `POST /v1/send` — send to one or more users

```jsonc
// request — Expo-flavored message fields, but `to` is user id(s), not a device token
{
  "to": "u_123",                                      // or ["u_123", "u_456"]
  "title": "New message",
  "body": "Alice: see you at 3pm",
  "data": { "type": "dm", "conversationId": "c1" },   // Record<string, string>
  "badge": 3,                                          // optional — iOS app-icon badge
  "sound": "default",                                  // optional — iOS + Android
  "priority": "high"                                   // optional — "high" (default) | "normal"
}
// response 200 — one ticket per device the message was attempted on
{
  "data": [
    { "userId": "u_123", "status": "ok" },
    { "userId": "u_123", "status": "error", "error": "invalid" },
    { "userId": "u_456", "status": "ok" }
  ]
}
```

`to` expands to every device registered for those users in this tenant. A multi-device
user yields one ticket per device (all carrying the same `userId`). Any token a provider
reports dead is deleted server-side in the same request — callers never have to manage
token lifecycle themselves.

## Configuration

push-hub stores tenants in Postgres (provider credentials encrypted at rest), not in
env config. A running deployment needs two secrets beyond its database URL:

| Env var | Plane | Purpose |
|---|---|---|
| `PUSH_HUB_ENROLL_KEY` | deploy/agent | Registration-only. Authorizes `POST /v1/tenants` to claim a **new, unclaimed** slug — nothing else. Generate with `openssl rand -hex 24`. Keep it in the deploy/agent plane, not in each app's runtime env. |
| `PUSH_HUB_CRED_KEY` | server | 32-byte (64 hex char) AES-256-GCM key encrypting tenant creds at rest. Generate with `openssl rand -hex 32`. **Must be stable per environment forever** — changing it makes existing encrypted creds unrecoverable (the service fails to boot, by design). dev and prod get their own keys. |

See `.env.example` for the full set. There is no `PUSH_HUB_TENANTS` — tenants self-register.

### Registering a tenant (self-service)

An agent provisioning an app registers it once with the enroll key:

```bash
curl -sX POST http://push-hub:3000/v1/tenants \
  -H "Authorization: Bearer $PUSH_HUB_ENROLL_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "slug": "my-app",
    "apns": { "keyId": "...", "teamId": "...", "bundleId": "com.example.myapp",
              "signingKey": "<base64 of the .p8>", "production": true },
    "fcm":  { "projectId": "...", "clientEmail": "...", "privateKey": "..." }
  }'
# → 201 { "slug": "my-app", "apiKey": "phk_…" }   ← shown ONCE; give it to the app's .env
```

`apns` and `fcm` are each optional (an iOS-only or Android-only app needs just one), but
**at least one is required**. The `slug` is the app's **permanent** identifier — a
lowercase DNS-1123 label (`a-z`, `0-9`, and hyphens; must start and end alphanumeric;
≤63 chars) that can't be changed later, so choose it deliberately. The first registrant
of a slug owns it; a second registration of the same slug returns `409`. Registration validates credential *shape*,
not correctness — a well-formed-but-wrong `.p8`/Firebase key registers successfully and
only fails at first send.

### Fixing bad credentials

Because registration only checks shape, the recovery path for wrong creds is a
tenant-key-authed full replacement (send the complete provider set you want; omitted
providers are dropped):

```bash
curl -sX PUT http://push-hub:3000/v1/tenant/credentials \
  -H "Authorization: Bearer $APP_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{ "apns": { … }, "fcm": { … } }'
# → 200 { "ok": true }
```

A tenant's API key manages **only its own** tenant. Key rotation / deregistration are
operator actions (`scripts/new-tenant-key.sh` + a container restart).

## Adopting push-hub in an app

Apps on the same internal Docker network reach push-hub by DNS at `http://push-hub:3000`
(or `http://push-hub-dev:3000` for dev) — it is not exposed publicly, and no separate
service registry is needed.

1. **Register the tenant** with the enroll key (see Configuration above) and put the
   returned `phk_…` key in the app's own `.env` / secret store.
2. On the client, register each native device token via `POST /v1/tokens` once it is
   available and again whenever it refreshes; on sign-out call `DELETE /v1/tokens`.
3. On the server, call `POST /v1/send` with the target `userId`(s) — push-hub fans out
   across that user's devices and cleans up dead tokens.

See the built-in engine's [integration guide](docs/engine-integration.md) for how native
tokens and provider credentials work; push-hub moves the storage, fan-out, and cleanup
server-side, shared across apps.

## License

MIT
