---
dev-flow:
  slug: consolidate-engine
  stops: []
---

# Consolidate push-service engine into push-hub

## Context

`@tsteil/push-service` is a small APNs+FCM push engine, currently a **separate repo** consumed by push-hub as a git dependency pinned at `github:tayl0r/push-service#v1.1.1`. push-hub is the only consumer, and nothing else will embed the engine as a library (all other apps integrate through push-hub's HTTP API). The separate-repo split therefore buys nothing and costs a 4-step version-pin dance on every engine change, lockstep cross-repo evolution, and doubled CI/ops.

**Goal:** fold the engine into push-hub as internal source at `src/engine/`, dropping the package/publish boundary entirely. Pure relocation — the pinned engine (`v1.1.1`) is byte-identical to the engine's current `main` HEAD (confirmed: HEAD `57b206c` is tagged `v1.1.1`), so there is **no runtime behavior change**.

## Decisions (locked)

- **Clean copy**, not history-preserving subtree — one commit, clear diff. Engine history stays recoverable in the archived old repo.
- **Metrics gap is OUT OF SCOPE** — push-hub still lacks a `/metrics` endpoint + `prometheus.io/*` labels (a DEPLOY.md requirement). That is a separate follow-up, not part of this refactor.
- **Old-repo teardown is external and post-merge** (archive `tayl0r/push-service` on GitHub, delete `~/dev/push-service`) — NOT part of this PR's diff; the orchestrator does it after merge.

## Source of truth (copy FROM these absolute paths)

The engine currently lives at `/Users/taylor/dev/push-service/`. Copy from there (it still exists during execution; it is deleted only post-merge):

- Engine source (6 files): `/Users/taylor/dev/push-service/src/{apns,fcm,classify,concurrency,types,index}.ts`
- Engine tests (5 files): `/Users/taylor/dev/push-service/test/{apns,classify,concurrency,fcm,index}.test.ts`
- Integration doc: `/Users/taylor/dev/push-service/docs/INTEGRATION.md`
- Engine deps + versions (from push-service `package.json`): `apns2: ^12.2.0`, `google-auth-library: ^9.0.0`

## Changes (all in push-hub)

### 1. Engine → `src/engine/` (clean copy, 6 files)
Copy the 6 source files verbatim into `push-hub/src/engine/`. Their internal imports are already relative (`./apns.js`, `./fcm.js`, `./types.js`, etc.) and remain valid unchanged. `src/engine/index.ts` continues to export `createPushService` + `export * from './types.js'` — now an internal module, not a package entry.

### 2. Tests → `test/engine/` (5 files)
Copy the 5 test files into `push-hub/test/engine/`. In each file, rewrite **every** `../src/` specifier to `../../src/engine/` — this covers both `import` statements **and** `vi.mock(...)` calls, not just the module-under-test import. This distinction is load-bearing: `test/engine/index.test.ts` has two `vi.mock('../src/apns.js')` / `vi.mock('../src/fcm.js')` calls in addition to its `import … from '../src/index.js'`, and a `vi.mock` path that doesn't resolve to the relocated module silently fails to intercept `src/engine/index.ts`'s `./apns.js` / `./fcm.js` imports — breaking that suite. (`../src/` is the only `../` target in these five files — verified — so a blanket rewrite is complete and safe.) No vitest config change: push-hub's default glob picks up `test/engine/*.test.ts`; the engine tests import `vitest` explicitly (no `globals` reliance) and are pure unit tests (mocked `apns2` / `google-auth-library` transports, no DB), so push-hub's DB `globalSetup` / `fileParallelism:false` settings are harmless.

### 3. Rewrite the 2 consumer imports
- `src/registry.ts`: `from '@tsteil/push-service'` → `from './engine/index.js'` (imports `createPushService`, `ApnsConfig`, `FcmConfig`, `PushService`, `PushServiceConfig`).
- `src/routes/tenants.ts`: `from '@tsteil/push-service'` → `from '../engine/index.js'` (imports types `ApnsConfig`, `FcmConfig`).

### 4. package.json
- Remove dependency `"@tsteil/push-service": "github:tayl0r/push-service#v1.1.1"`.
- Add dependencies `"apns2": "^12.2.0"` and `"google-auth-library": "^9.0.0"`.
- devDeps unchanged (engine's devDeps — @types/node, typescript, vitest — are already present).

### 5. pnpm-workspace.yaml
- Remove the `"@tsteil/push-service": true` line from `allowBuilds`; keep `esbuild: true`.
- Update the explanatory comment: the git-dep `prepare`-build rationale is gone (only esbuild's native build remains) — **but keep the note on why `packageManager` pins `pnpm@11.5.0`**. That pin exists because pnpm's `allowBuilds` bare-name key-matching changed across 11.x, and the surviving `esbuild: true` bare-name entry still depends on it; don't delete that rationale along with the git-dep prose.

### 6. Dockerfile
- Remove `RUN apk add --no-cache git` — git existed solely to clone the git-dependency at install time; the engine is now local source with no git deps.
- Trim/replace the two comments that explain the git-dep clone + the allowBuilds-for-git-dep rationale.
- Everything else stays: `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./` (still needed — pnpm-workspace.yaml still carries `esbuild` allowBuild), `pnpm install --frozen-lockfile`, `pnpm build`, single-stage CMD.

### 7. Docs + README
- Copy `/Users/taylor/dev/push-service/docs/INTEGRATION.md` into `push-hub/docs/engine-integration.md`, then **adapt its now-obsolete package references so the copy is genuinely self-contained** — a verbatim copy is not, because the doc is written for external npm consumers of the published package. Specifically: retitle the `# Integrating `@tsteil/push-service`` heading (line ~1) to name the internal engine; repoint/annotate the `import { createPushService, … } from '@tsteil/push-service'` example (line ~116) to the internal `src/engine` module — nothing imports the engine as a package anymore; push-hub's own `src/registry.ts` is the only importer, via `./engine/index.js`; and relabel the `@tsteil/push-service` column in the `expo-server-sdk` comparison table (line ~200). After this, `docs/engine-integration.md` must contain **no** `@tsteil/push-service` / `tayl0r/push-service` references.
- README (`push-hub/README.md`):
  - Line ~4: reword the `[@tsteil/push-service](github…)` reference to describe the built-in engine (`src/engine/`), not an external package.
  - Lines ~140–141: repoint the integration-guide link from the external push-service repo to the local `docs/engine-integration.md`.
  - Remove any remaining `@tsteil/push-service` / `github.com/tayl0r/push-service` references.

### 8. Lockfile
- Regenerate `pnpm-lock.yaml` via `pnpm install`, **run with the pinned pnpm** (`corepack prepare pnpm@11.5.0 --activate`, matching `packageManager`) so the lockfile format matches what the Docker build's `pnpm install --frozen-lockfile` (also pnpm@11.5.0) expects — a version drift here is a classic frozen-lockfile CI failure. Regeneration drops the git-dep graph and adds apns2 + google-auth-library + transitive deps.

## Out of scope
- Prometheus `/metrics` endpoint + `prometheus.io/*` compose labels (separate follow-up).
- Any engine logic change, API change, or version bump.

## External post-merge actions (NOT in the PR)
Done by the orchestrator after the PR merges, with the user's already-recorded consent:
1. Archive `tayl0r/push-service` on GitHub (read-only) with a note "merged into tayl0r/push-hub".
2. Delete the local `~/dev/push-service` working copy.

## Verification
- `pnpm install` succeeds and updates the lockfile.
- `pnpm build` (tsc) is clean — no dangling `@tsteil/push-service` module resolution.
- `pnpm test` — all suites green (existing push-hub tests + the 5 relocated engine tests).
- `grep -rn '@tsteil/push-service\|tayl0r/push-service'` across the **functional + user-facing surface** returns nothing: `src/`, `test/`, `package.json`, `pnpm-workspace.yaml`, `Dockerfile`, `pnpm-lock.yaml`, `README.md`, and the new `docs/engine-integration.md`. **Explicitly out of scope of this grep** (must NOT be rewritten): the historical planning records under `docs/superpowers/plans/` and `docs/superpowers/specs/` — including this design doc itself — which are immutable point-in-time records that legitimately name the old package. A blanket `docs/`-wide grep is the wrong check: it always matches that history and can never pass.
- CI on push to `main` builds `:dev` and deploys to `push-hub-dev.tsteil.com` first (safe) before any prod promotion.

## Risk
Low — relocation only, no logic change, engine source identical to the deployed pin. The one must-be-correct item is the simplified Dockerfile; CI's dev build surfaces any breakage before prod.
