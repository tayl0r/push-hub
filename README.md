# push-hub

A self-hosted, multi-tenant push-notification service. It owns the `user → device
tokens` mapping and sends **by user id**, using [`@tsteil/push-service`](https://github.com/tayl0r/push-service)
as its APNs/FCM sending engine.

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

push-hub loads its tenants from a single JSON env var, `PUSH_HUB_TENANTS`, so
credentials stay in the deploy environment and never touch the database:

```jsonc
[
  {
    "slug": "my-app",
    "apiKeyHash": "<sha256 hex digest of the app's key>",
    "apns": {
      "keyId": "...", "teamId": "...", "bundleId": "com.example.myapp",
      "signingKey": "<base64-encoded .p8 contents>", "production": true
    },
    "fcm": { "projectId": "...", "clientEmail": "...", "privateKey": "..." }
  }
]
```

`apns` and `fcm` are each optional per tenant (an iOS-only or Android-only app doesn't
need both), but **at least one is required** — a tenant with neither is rejected at
startup. A structurally malformed provider block also fails startup, not the first
send. See `.env.example` for the full set of env vars the service reads.

### Generating an app key

Each tenant's API key is an opaque random string the app sends as a bearer token; only
its SHA-256 hash is stored in `PUSH_HUB_TENANTS`.

```bash
# 1. generate the key — give this raw value to the app, once
openssl rand -hex 24

# 2. hash it — this is what goes in apiKeyHash
echo -n "<the key from step 1>" | shasum -a 256 | awk '{ print $1 }'
```

## Adopting push-hub in an app

Give the app its `slug` + generated key and add its APNs/FCM credentials to
`PUSH_HUB_TENANTS`. On the client, register each native device token (via
`POST /v1/tokens`) once it's available and again whenever it's refreshed; on
sign-out, call `DELETE /v1/tokens`. On the server, call `POST /v1/send` with the
target `userId`(s) whenever a notification should go out — push-hub handles fan-out
across that user's devices and dead-token cleanup for you. See
[`@tsteil/push-service`](https://github.com/tayl0r/push-service)'s
[integration guide](https://github.com/tayl0r/push-service/blob/main/docs/INTEGRATION.md)
for background on how native tokens and provider credentials work; push-hub just
moves the storage, fan-out, and cleanup steps it describes server-side, shared
across apps.

## License

MIT
