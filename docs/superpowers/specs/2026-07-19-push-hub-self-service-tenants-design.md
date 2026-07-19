# push-hub v1.1 — Self-Service Tenant Provisioning

**Date:** 2026-07-19
**Status:** design approved; spec under review
**Scope:** Let each consuming app's agent **self-register** its tenant and obtain an API key with no human step, while keeping strict **per-client isolation**. Move tenants from static env config into the database (provider credentials encrypted at rest), managed through a single `TenantRegistry` seam. Builds on the deployed v1.0 (env-config tenants, composite-key data isolation).

---

## Overview

Today a tenant is static env config: the operator writes a block into `PUSH_HUB_TENANTS` (slug + `apiKeyHash` + APNs/FCM creds) and redeploys. That is not self-service and does not scale to "an agent working on app X provisions app X."

v1.1 introduces **trust-on-first-use (TOFU)** provisioning across two privilege planes:

- **Enrollment plane (self-service, low-privilege).** One shared `PUSH_HUB_ENROLL_KEY`, held in the *agent/deploy* plane (deploy tooling, the `vps/DEPLOY.md` tier) — **not** in each running app's runtime env, because registration is a deploy-time act by the agent, and the running app only ever needs its own tenant key. The enroll key can do exactly one thing: register a **new, unclaimed** slug. It cannot read, modify, or delete any existing tenant. A leaked enroll key's entire blast radius is "squat an unclaimed slug" — detectable, and recoverable with a one-row `DELETE`.
- **Management plane (per-client isolated).** Registration returns a **per-tenant API key, shown once**. That key is the client's identity: it authorizes sending (the existing `/v1/tokens` + `/v1/send`) *and* managing **only its own** tenant. A client holds only its own key, so it can never touch another's tenant.
- **Slug lock (the TOFU part).** The first registrant of a slug owns it; a later `POST /v1/tenants` for a claimed slug → `409`. This is what stops app A from clobbering app B.

**Why this is the long-term-correct shape** (validated by adversarial review against the real code): tenants become **DB-only** (the env source is deleted, not kept alongside — see §Tenant source), all tenant state and every mutation flow through **one registry** so the write path is single-owner and correct-by-default, and the credential-update route is **mandatory** rather than a nice-to-have (see §Why the credentials route is required).

---

## Design decisions (and their rationale)

1. **Tenant source: DB only. Delete `PUSH_HUB_TENANTS`.** Both deployments run with `PUSH_HUB_TENANTS=[]` today — zero env tenants exist and no app holds provider creds yet, so there is no install base to migrate and the source swap is atomic and free. Keeping env *and* DB sources would create the exact latent-regression family we avoid elsewhere: precedence rules, "can't rotate an env tenant via the API," a restart resurrecting a deregistered tenant. One source, one code path. The three known apps (`team-comm`, `substitute`, `setpiece`) are **not** pre-seeded — their agents register them like any future app; squatting recovery is a one-row `DELETE`, not a reservation subsystem.

2. **`TenantRegistry` is the shared boundary.** One class owns the whole tenant-mutation family — boot load, `register`, `updateCredentials`, key-hash lookup — and every mutation performs the DB write **and** the in-memory `Map` update together, so no caller can update one and forget the other. The engine is built **before** the row commits, so the DB never persists unbuildable creds.

3. **Engine lifecycle: eager build at boot; in-memory write-through swap on mutation.** push-hub runs a single process in a single container per environment (`docker-compose.yml`, no replicas; dev and prod are separate stacks with separate DBs). So "hot-reload" is literally mutating the closed-over `Map` — one `Map.set`, no invalidation protocol, no cross-instance sync. **A swapped-out engine must be closed, not left to GC:** `apns2`'s `ApnsClient` starts a 10-minute keep-alive `setInterval` in its constructor whose timer roots the client even after `.unref()`, so a replaced APNs engine would leak (client + timer + live HTTP/2 sessions) for the process lifetime. So `@tsteil/push-service` gains an optional `PushService.close()` (published as **v1.1.1** — `ApnsTransport` → `client.destroy()`; `FcmTransport` a no-op, since `GoogleAuth` holds no timers/sockets), and `TenantRegistry.updateCredentials` closes the replaced engine after the swap — which also gives push-hub graceful shutdown for free. Rejected alternatives: *reload-on-read* (per-request DB lookup + staleness machinery, re-deriving what the `Map` already holds, loses boot fail-loud); *restart-required* (agent registers, sends, gets 401 until a human restarts — a caller-must-remember footgun).

4. **Fail-loud at boot, preserved.** The registry's boot load decrypts every tenant's creds and builds every engine, throwing on any failure — the same "fail the deploy, not the first send" property v1.0 had for malformed env config. A wrong `PUSH_HUB_CRED_KEY` therefore surfaces at deploy time (decryption fails) rather than at some tenant's first send.

5. **Credentials encrypted at rest, minimally.** Moving creds from a host-only env file into Postgres puts them into dumps and backups, so encryption at rest is the correct-by-default counterpart — and matches the existing hygiene tier (API keys are already stored hashed). AES-256-GCM, one symmetric key in `PUSH_HUB_CRED_KEY`, a random IV per row, `iv‖tag‖ciphertext` in a single column, inside one small module that only the registry touches. No KMS, no per-tenant DEKs, no cred-key rotation machinery — that is where over-engineering begins.

6. **Registration validates credential *shape*, not correctness** — and that is why the update route is required (see §Why the credentials route is required).

---

## Data model

One new table. `push_tokens` is unchanged (no foreign key to `tenants` — the composite-key data isolation in `src/store.ts` already does the structural work, and coupling the two tables is deferred, unneeded complexity).

```ts
tenants = pgTable('tenants', {
  id:         uuid('id').primaryKey().defaultRandom(),
  slug:       text('slug').notNull(),
  apiKeyHash: text('api_key_hash').notNull(),        // sha256 hex of the tenant's API key
  credsEncrypted: text('creds_encrypted').notNull(), // AES-256-GCM base64(iv‖tag‖ciphertext) of JSON { apns?, fcm? }
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('tenants_slug_unique').on(t.slug),              // slug ownership (DB-enforced TOFU lock)
  unique('tenants_api_key_hash_unique').on(t.apiKeyHash), // one key → one tenant
])
```

- `slug` unique is the **TOFU lock**: a second registration of the same slug fails the unique constraint → surfaced as `409`.
- `credsEncrypted` holds the encrypted JSON of `{ apns?, fcm? }` (the same shapes v1.0's `PUSH_HUB_TENANTS` entries carried, minus `slug`/`apiKeyHash`).
- No plaintext key and no plaintext creds are ever stored.

---

## Components

### `src/crypto.ts` — credential encryption (~20 lines)
- `encrypt(key: Buffer, plaintext: string): string` — AES-256-GCM with a fresh random 12-byte IV, returning base64 of `iv‖authTag‖ciphertext`.
- `decrypt(key: Buffer, blob: string): string` — the inverse; throws on a bad tag (tamper/wrong key).
- **Pure functions — the key is passed in, never read from `process.env` here.** This keeps the registry and its tests env-free, matching the codebase's dependency-injection seam (only `index.ts` reads env; everything else takes injected deps, which is what keeps the whole suite env-free). `PUSH_HUB_CRED_KEY` (32 bytes as 64 hex chars) is read and length-validated in exactly one place: `src/env.ts`.

### `src/registry.ts` — `TenantRegistry` (the shared boundary)
Holds `Map<apiKeyHash, Tenant>` where `Tenant = { slug, apiKeyHash, engine }` (unchanged from v1.0). Constructed with `{ db, buildEngine, credKey }` — `buildEngine = createPushService` by default (injected so tests can substitute it), and `credKey` is the injected encryption key (validated in `env`, never read here).

- `load(): Promise<void>` — read all `tenants` rows; for each: `decrypt` creds → parse → `buildEngine({apns,fcm})` → put `{slug, apiKeyHash, engine}` in the Map. **Throws on any decrypt/build failure** (boot fail-loud).
- `byKeyHash(hash): Tenant | undefined` — the data-plane + management-plane auth lookup.
- `register({ slug, apns?, fcm? }): Promise<{ slug, apiKey }>`:
  1. require at least one of `apns`/`fcm` (reuse the v1.0 loader invariant) → else `InvalidCreds`.
  2. `buildEngine({apns,fcm})` — throws on malformed provider block → `InvalidCreds` (→ 400).
  3. generate `apiKey = phk_<random>`; `apiKeyHash = sha256(apiKey)`; `credsEncrypted = encrypt(JSON.stringify({apns,fcm}))`.
  4. `INSERT` the row; a unique violation (Postgres `23505`) → `SlugTaken` (→ 409). Any `23505` on insert is treated as a taken slug — an `api_key_hash` collision on 24 random bytes isn't a real event.
  5. on success, `Map.set(apiKeyHash, {slug, apiKeyHash, engine})`.
  6. return `{ slug, apiKey }` (the plaintext key, once).
  Ordering: engine built (step 2) before the row commits (step 4); Map updated (step 5) only after the commit succeeds.
- `updateCredentials(tenant, { apns?, fcm? }): Promise<void>`:
  1. require ≥1 provider; `buildEngine` (throws → `InvalidCreds` → 400).
  2. `UPDATE` the row's `credsEncrypted` + `updatedAt` (by `tenant.apiKeyHash`).
  3. swap the Map entry's engine (same `apiKeyHash` key; the API key does not change).

Typed errors (`InvalidCreds`, `SlugTaken`) let the routes map to 400/409 without leaking internals.

### `src/auth.ts` — additions
- `requireTenant(registry)` (repointed from a bare `Map` to `registry.byKeyHash`) — unchanged behavior; sets `req.tenant`. Used by `/v1/tokens`, `/v1/send`, and `PUT /v1/tenant/credentials`.
- `requireEnrollKey(enrollKey)` — new preHandler: `Bearer <key>`, compared to `PUSH_HUB_ENROLL_KEY` with `timingSafeEqual` over sha256 digests (constant-time, length-independent). Missing/blank/wrong → 401. Used only by `POST /v1/tenants`.

### `src/routes/tenants.ts` — the provisioning routes
- **`POST /v1/tenants`** — preHandler `requireEnrollKey`. Body (zod): `{ slug: string≥1, apns?: object, fcm?: object }`. → `registry.register(...)`. `201 { slug, apiKey }`. `InvalidCreds` → 400; `SlugTaken` → 409; bad body → 400.
- **`PUT /v1/tenant/credentials`** — preHandler `requireTenant`. Body (zod): `{ apns?: object, fcm?: object }` (≥1 present). → `registry.updateCredentials(req.tenant, ...)`. `200 { ok: true }`. `InvalidCreds` → 400. A client can only ever update the tenant its key resolves to. This is a **full replacement** of the tenant's provider set, not a merge — sending only `{ apns }` on a dual-provider tenant drops FCM (replacement avoids a "how do I remove a provider?" hole; agents send the complete provider set).

### Wiring changes (`src/config.ts`, `src/env.ts`, `src/app.ts`, `src/index.ts`)
- **`src/env.ts`**: remove `PUSH_HUB_TENANTS`; add `PUSH_HUB_ENROLL_KEY` (required, non-empty) and `PUSH_HUB_CRED_KEY` (required, 64 hex chars).
- **`src/config.ts`** is **deleted**: `loadTenants` and its `TenantInput`/provider-shape validation move into `registry.register`, and the `Tenant` type moves to `src/registry.ts` (imported by `auth.ts`'s `declare module 'fastify'` and the route files). `test/config.test.ts` is removed with `loadTenants`; the four existing suites that hand-build a `Map` into `buildApp({ db, tenants })` (`app`, `auth`, `send.route`, `tokens.route`) migrate to the registry-shaped deps.
- **`src/app.ts` / `src/index.ts`**: build one `TenantRegistry({ db })`, `await registry.load()` at boot (replaces `loadTenants(env.PUSH_HUB_TENANTS)`), pass it to `buildApp`; register the new routes. Boot log reports tenant count from the registry.

---

## Why the credentials route is required (not deferred)

`createPushService` validates only credential **shape**: `ApnsTransport` checks the required fields are present and that `signingKey` base64-decodes to text containing `BEGIN PRIVATE KEY` (`@tsteil/push-service` `src/apns.ts`); FCM auth is lazy (first send). So a **well-formed-but-wrong** `.p8` or Firebase key passes registration and only fails at first send (`classifyApns` → `config` → thrown → 500). The single most likely self-registration failure is therefore *"slug claimed, key issued, creds bad."* Without a tenant-key-authed credentials update, the agent is deadlocked behind the operator — defeating self-service for the common case. Hence `PUT /v1/tenant/credentials` is the minimum management surface, not an add-on. (A real provider dry-run at registration — bogus-token send distinguishing `BadDeviceToken` from `InvalidProviderToken`; FCM `validate_only` — is possible but couples registration to provider error taxonomies and adds flake; we document shape-only validation and ship the update route instead.)

---

## Auth model summary

| Plane | Route(s) | Credential | Scope |
|---|---|---|---|
| Data | `POST/DELETE /v1/tokens`, `POST /v1/send` | tenant API key | own tenant only |
| Enrollment | `POST /v1/tenants` | shared `PUSH_HUB_ENROLL_KEY` | create a new unclaimed slug only — no read/update/delete |
| Management | `PUT /v1/tenant/credentials` | tenant API key | own tenant only |

---

## Configuration & deployment

New env vars (both replace/extend the v1.0 set):

```env
# removed: PUSH_HUB_TENANTS
PUSH_HUB_ENROLL_KEY=<opaque secret; agent/deploy-plane only>   # openssl rand -hex 24
PUSH_HUB_CRED_KEY=<64 hex chars = 32 bytes>                      # openssl rand -hex 32
```

- `PUSH_HUB_CRED_KEY` must be **stable per environment** — if it changes, existing encrypted creds can't be decrypted (boot fails loud, by design). dev and prod get their **own** cred keys (separate DBs).
- `PUSH_HUB_ENROLL_KEY` is generated per environment and distributed only to the deploy/agent plane.
- The engine dependency bumps to **`github:tayl0r/push-service#v1.1.1`** (adds `PushService.close()`, §Design decision 3), published first (like the v1.1.0 bump), then push-hub's `package.json` + lockfile update.
- Deploy runs the new migration (adds `tenants`), then boots; **dev first**, so a mis-set `PUSH_HUB_CRED_KEY` bricks dev's boot, not prod's.
- `.env.example` documents the two new vars and drops `PUSH_HUB_TENANTS`; the VPS `/opt/apps/push-hub{,-dev}/.env` files are updated over SSH (server-side only).

---

## Testing

- **crypto**: encrypt→decrypt round-trips; `decrypt` throws on a tampered blob and on a wrong key; a non-32-byte `PUSH_HUB_CRED_KEY` is rejected.
- **registry** (DB + injected `buildEngine` mock): `load` builds an engine per row and throws if `buildEngine` throws; `register` returns a key, inserts an encrypted row, and hot-adds to the Map (a subsequent `byKeyHash` resolves it); `register` on a taken slug → `SlugTaken`; `register` with a provider block that makes `buildEngine` throw → `InvalidCreds` and **no row written**; `updateCredentials` re-encrypts the row and swaps the Map engine; the stored `credsEncrypted` is not plaintext.
- **routes**: `POST /v1/tenants` with the enroll key registers (assert the tenant then authenticates on `/v1/send`); missing/wrong enroll key → 401; **a valid *tenant* key on `POST /v1/tenants` → 401** (a data-plane key can never enroll — pins plane separation); taken slug → 409; bad body / zero providers → 400. `PUT /v1/tenant/credentials` with a tenant key updates its own creds; a **full-replacement** check — updating an `apns`+`fcm` tenant with `{ fcm }` only drops `apns`; **cross-tenant isolation** — tenant A's key cannot update tenant B (A only ever reaches its own row via `req.tenant`); wrong/no key → 401.
- **boot fail-loud**: `load` against a row whose creds don't decrypt (wrong key) throws.

---

## Out of scope (deferred, with the fallback that covers each)

- **Self-serve key rotation** — real lockout footgun (agent rotates, fails to persist the once-returned key, locked out); keys don't expire; leak recovery is the operator updating `api_key_hash` **then restarting the container** (see the restart rule) and re-running the recovery helper.
- **Deregister** — destructive and rare; operator `DELETE` **+ container restart** is fine.
- **`GET /v1/tenant` introspection** — add in a few lines if agents actually fumble.
- **Provider dry-run validation** at registration — couples to provider error taxonomies; the credentials-update route is the pragmatic recovery instead.
- **KMS / per-tenant DEKs / cred-key rotation** — one env-held symmetric key matches the threat model (owner's own agents on a private host; defense-in-depth against a confused agent, not a hostile adversary).
- **FK `push_tokens.app_slug → tenants.slug`** — composite-key isolation already does the structural work; coupling is unneeded.
- **Multi-instance engine-cache invalidation** — single container per environment; no protocol needed until there are replicas.

**Restart rule (applies to every operator fallback above):** the running process serves tenants from its in-memory `Map`, so any out-of-band DB mutation (a `DELETE`, an `api_key_hash` `UPDATE`) takes effect only at the next boot, when `load()` rebuilds the `Map`. Until then the old state keeps serving — operator recovery therefore always ends with a container restart.

---

## Discovery (self-service's other half — lands with this work)

So an agent working on another app can *find* push-hub without a human: add a one-line pointer to each consuming app's `CLAUDE.md` (or the shared `vps/CLAUDE.md`) — "push notifications: register at `http://push-hub:3000` via `POST /v1/tenants` with the enroll key; see `github.com/tayl0r/push-hub`." **This work also rewrites the README and the helper script**, which today document the *removed* v1.0 flow (the `PUSH_HUB_TENANTS` block, the `new-tenant-key.sh` skeleton): the README Configuration + "Adopting push-hub" sections are rebuilt around `POST /v1/tenants` / `PUT /v1/tenant/credentials`, and `scripts/new-tenant-key.sh` is reworked for the DB world — emitting the operator's `UPDATE tenants SET api_key_hash = …` leak-recovery statement instead of a `PUSH_HUB_TENANTS` block. The discovery pointer then sends agents to an accurate README.
