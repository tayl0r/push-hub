---
dev-flow:
  slug: consolidate-engine
  spec: docs/superpowers/specs/2026-07-22-consolidate-engine-design.md
---

# Consolidate push-service engine into push-hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the standalone `@tsteil/push-service` git dependency into push-hub as internal source at `src/engine/`, dropping the package/publish boundary with zero runtime behavior change.

**Architecture:** Pure relocation. The pinned engine (`github:tayl0r/push-service#v1.1.1`) is byte-identical to the engine repo's current `main` HEAD, so this is a clean copy of 6 source files + 5 test files into push-hub, a swap of 2 consumer imports from the package name to relative paths, a dependency swap (drop the git-dep, add the engine's two direct runtime deps), and doc/Docker/lockfile follow-through. No engine logic, API, or version changes.

**Tech Stack:** TypeScript (ESM, `"type": "module"`, NodeNext-style `.js` import specifiers), pnpm 11.5.0 (pinned via `packageManager`), vitest, Node 22, Docker (`node:22-alpine`).

## Global Constraints

- **Run pnpm as the pinned version.** Before any `pnpm install`, activate the pin: `corepack enable && corepack prepare pnpm@11.5.0 --activate`. A pnpm version drift produces a lockfile the Docker build's `pnpm install --frozen-lockfile` (also 11.5.0) rejects — a classic CI failure.
- **All work happens in the push-hub worktree:** `/Users/taylor/dev/push-hub/.claude/worktrees/dev-flow-consolidate-engine` on branch `dev-flow/consolidate-engine`. Every relative path below is relative to this directory. Run every command from this directory.
- **Copy the engine FROM the still-present source repo** at `/Users/taylor/dev/push-service/` (absolute paths given per file). That repo exists during execution and is deleted only post-merge — never assume it is gone.
- **Engine dep versions are exact** (from push-service `package.json`): `apns2: ^12.2.0`, `google-auth-library: ^9.0.0`.
- **ESM import specifiers keep the `.js` extension** (e.g. `./engine/index.js`) even though the source file is `.ts` — this is the existing convention throughout push-hub and the engine.
- **Do NOT touch the historical planning records** under `docs/superpowers/plans/` or `docs/superpowers/specs/` (including this plan and the design doc). They legitimately name the old package and are immutable point-in-time records. The final verification grep is deliberately scoped to the functional + user-facing surface and must NOT be widened to a `docs/`-wide grep (that always matches this history and can never pass).
- **Test-DB precondition for full-suite runs.** push-hub's DB-backed suites (`store`, `tenants.route`, `send.route`) build their client from `process.env.TEST_DATABASE_URL` and `TRUNCATE` between cases, so a full `pnpm test` requires a provisioned test DB reachable via `TEST_DATABASE_URL` (the repo's standard test setup; vitest's `globalSetup` is a documented no-op when the var is unset). This is a pre-existing repo precondition, unchanged by this plan. If those DB suites fail for a missing/unreachable DB, that is an environment gap, **not** a defect introduced by this change — the relocated engine suites are pure unit tests (mocked `apns2` / `google-auth-library`, no DB) and are proven independently by `pnpm test -- test/engine`, which passes with no DB configured.
- **Out of scope (do not implement):** any `/metrics` endpoint or `prometheus.io/*` labels; any engine logic/API change or version bump; archiving/deleting the old `push-service` repo (the orchestrator does that post-merge, outside this PR).

---

## File Structure

Files created in push-hub:
- `src/engine/{apns,classify,concurrency,fcm,index,types}.ts` — the vendored engine (6 files, verbatim copies).
- `test/engine/{apns,classify,concurrency,fcm,index}.test.ts` — the relocated engine unit tests (5 files, with rewritten import/mock paths).
- `docs/engine-integration.md` — adapted copy of the engine's INTEGRATION.md.

Files modified in push-hub:
- `src/registry.ts` — consumer import repointed to `./engine/index.js`.
- `src/routes/tenants.ts` — consumer type import repointed to `../engine/index.js`.
- `package.json` — drop git-dep, add `apns2` + `google-auth-library`.
- `pnpm-workspace.yaml` — drop the `@tsteil/push-service` allowBuild line + rewrite the comment.
- `pnpm-lock.yaml` — regenerated.
- `Dockerfile` — remove the `git` install + trim git-dep comments.
- `README.md` — repoint two `@tsteil/push-service` references to the built-in engine.

---

## Task 1: Vendor the engine into `src/engine/` and swap dependencies

This is the heart of the PR. Copying the source, repointing the two consumers, and swapping the dependencies must land together: the git-dep is what currently supplies `apns2` + `google-auth-library` transitively, and pnpm's strict `node_modules` will not resolve those from `src/engine/` until they are declared as direct deps. Splitting these would leave an intermediate state where `pnpm build` cannot resolve the engine's transports.

**Files:**
- Create: `src/engine/apns.ts`, `src/engine/classify.ts`, `src/engine/concurrency.ts`, `src/engine/fcm.ts`, `src/engine/index.ts`, `src/engine/types.ts`
- Modify: `src/registry.ts` (line 9), `src/routes/tenants.ts` (line 3), `package.json` (dependencies block), `pnpm-workspace.yaml` (full file), `pnpm-lock.yaml` (regenerated)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: internal module `src/engine/index.ts` exporting `createPushService` and re-exporting types via `export * from './types.js'`. Named exports relied on downstream: value `createPushService`; types `ApnsConfig`, `FcmConfig`, `PushService`, `PushServiceConfig`, `PushTarget`. Import path from `src/`: `./engine/index.js`; from `src/routes/`: `../engine/index.js`.

- [x] **Step 1: Copy the 6 engine source files verbatim**

The files' internal imports are already relative (`./apns.js`, `./fcm.js`, `./types.js`, …) and stay valid unchanged.

```bash
mkdir -p src/engine
cp /Users/taylor/dev/push-service/src/apns.ts        src/engine/apns.ts
cp /Users/taylor/dev/push-service/src/classify.ts    src/engine/classify.ts
cp /Users/taylor/dev/push-service/src/concurrency.ts src/engine/concurrency.ts
cp /Users/taylor/dev/push-service/src/fcm.ts         src/engine/fcm.ts
cp /Users/taylor/dev/push-service/src/index.ts       src/engine/index.ts
cp /Users/taylor/dev/push-service/src/types.ts       src/engine/types.ts
```

- [x] **Step 2: Verify the copy landed and internal imports are relative**

```bash
ls src/engine/
grep -rn "@tsteil/push-service" src/engine/ || echo "OK: no package self-references"
```
Expected: 6 `.ts` files listed; `OK: no package self-references`.

- [x] **Step 3: Repoint the `src/registry.ts` consumer import**

Replace the package specifier with the relative engine path. In `src/registry.ts`, the import block (lines 3-9) ends with:
```ts
} from '@tsteil/push-service'
```
Change that closing line to:
```ts
} from './engine/index.js'
```
(The imported names — `createPushService`, `ApnsConfig`, `FcmConfig`, `PushService`, `PushServiceConfig` — stay exactly as they are.)

- [x] **Step 4: Repoint the `src/routes/tenants.ts` consumer import**

In `src/routes/tenants.ts`, line 3 is:
```ts
import type { ApnsConfig, FcmConfig } from '@tsteil/push-service'
```
Change it to:
```ts
import type { ApnsConfig, FcmConfig } from '../engine/index.js'
```

- [x] **Step 5: Verify no consumer still references the package**

```bash
grep -rn "@tsteil/push-service" src/
```
Expected: no output.

- [x] **Step 6: Swap the dependencies in `package.json`**

In the `"dependencies"` block, remove the line:
```json
"@tsteil/push-service": "github:tayl0r/push-service#v1.1.1",
```
and add the engine's two direct runtime deps. The resulting `"dependencies"` block must read:
```json
  "dependencies": {
    "@sentry/node": "^10.0.0",
    "apns2": "^12.2.0",
    "drizzle-orm": "^0.38.0",
    "fastify": "^5.0.0",
    "google-auth-library": "^9.0.0",
    "postgres": "^3.4.0",
    "zod": "^3.0.0"
  },
```
`devDependencies` are unchanged (the engine's devDeps — `@types/node`, `typescript`, `vitest` — are already present).

- [x] **Step 7: Update `pnpm-workspace.yaml`**

Remove the `"@tsteil/push-service": true` allowBuild line and rewrite the comment to drop the git-dep `prepare`-build rationale while keeping the note on why `packageManager` pins `pnpm@11.5.0` (the surviving bare-name `esbuild: true` entry still depends on that pin, because pnpm's `allowBuilds` bare-name key-matching changed across 11.x). Replace the entire file with:
```yaml
# pnpm v11 gates native build scripts behind this allowlist — without `esbuild` here,
# pnpm silently skips its native postinstall build. pnpm's allowBuilds bare-name
# key-matching changed across 11.x, so package.json pins `packageManager: pnpm@11.5.0`
# to keep local dev and the Docker build on the identical pnpm; this bare-name form is
# what that version matches.
allowBuilds:
  esbuild: true
```

- [x] **Step 8: Regenerate the lockfile with the pinned pnpm and install**

```bash
corepack enable && corepack prepare pnpm@11.5.0 --activate
pnpm install
```
Expected: install succeeds; `pnpm-lock.yaml` is updated — the git-dep subgraph is dropped and `apns2` + `google-auth-library` (plus their transitives) are added.

- [x] **Step 9: Verify the build is clean**

```bash
pnpm build
```
Expected: `tsc` completes with no errors — in particular no unresolved `@tsteil/push-service`, `apns2`, or `google-auth-library` modules.

- [x] **Step 10: Verify the existing push-hub suite still passes**

```bash
pnpm test
```
Expected: all existing push-hub suites green (`app`, `auth`, `crypto`, `env`, `registry`, `send.route`, `store`, `tenants.route`, `tokens.route`) — requires the test-DB precondition (see Global Constraints); a DB-env failure in the `store`/`*.route` suites is an environment gap, not a defect in this change. The engine tests are relocated in Task 2.

- [x] **Step 11: Commit**

```bash
git add src/engine src/registry.ts src/routes/tenants.ts package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "refactor: vendor push-service engine into src/engine and swap deps"
```

---

## Task 2: Relocate the 5 engine tests into `test/engine/`

**Files:**
- Create: `test/engine/apns.test.ts`, `test/engine/classify.test.ts`, `test/engine/concurrency.test.ts`, `test/engine/fcm.test.ts`, `test/engine/index.test.ts`

**Interfaces:**
- Consumes: `src/engine/` modules from Task 1 (imported via the rewritten `../../src/engine/…` paths).
- Produces: nothing downstream (leaf test suites).

**Why the blanket rewrite is load-bearing:** every `../src/` specifier must become `../../src/engine/` — this covers **both** `import` statements **and** `vi.mock(...)` calls. `test/engine/index.test.ts` has two `vi.mock('../src/apns.js')` / `vi.mock('../src/fcm.js')` calls in addition to its `import … from '../src/index.js'`. A `vi.mock` path that does not resolve to the relocated module silently fails to intercept `src/engine/index.ts`'s `./apns.js` / `./fcm.js` imports, so the mocks would be ignored and that suite would break against the real transports. `../src/` is the only `../` target in these five files (verified — 7 occurrences total: apns×1, classify×1, concurrency×1, fcm×1, index×3), so a blanket rewrite is complete and safe. No vitest config change is needed: push-hub's default glob picks up `test/engine/*.test.ts`; these suites import `vitest` explicitly (no `globals` reliance) and are pure unit tests (mocked `apns2` / `google-auth-library` transports, no DB), so push-hub's DB `globalSetup` / `fileParallelism:false` settings are harmless.

- [ ] **Step 1: Copy the 5 test files**

```bash
mkdir -p test/engine
cp /Users/taylor/dev/push-service/test/apns.test.ts        test/engine/apns.test.ts
cp /Users/taylor/dev/push-service/test/classify.test.ts    test/engine/classify.test.ts
cp /Users/taylor/dev/push-service/test/concurrency.test.ts test/engine/concurrency.test.ts
cp /Users/taylor/dev/push-service/test/fcm.test.ts         test/engine/fcm.test.ts
cp /Users/taylor/dev/push-service/test/index.test.ts       test/engine/index.test.ts
```

- [ ] **Step 2: Blanket-rewrite every `../src/` specifier to `../../src/engine/`**

Use `perl -i` (its `-i` behaves identically on macOS and Linux, unlike `sed -i`):
```bash
perl -pi -e 's#\.\./src/#../../src/engine/#g' test/engine/*.test.ts
```

- [ ] **Step 3: Verify the rewrite is complete (imports AND vi.mock)**

```bash
grep -rn "\.\./src/" test/engine/ && echo "FAIL: stale ../src/ remains" || echo "OK: no stale specifiers"
grep -rn "\.\./\.\./src/engine/" test/engine/ | wc -l
```
Expected: `OK: no stale specifiers`, and the count is `7` (apns×1, classify×1, concurrency×1, fcm×1, index×3 including the two `vi.mock` calls).

- [ ] **Step 4: Run the relocated engine suites**

```bash
pnpm test -- test/engine
```
Expected: all 5 engine suites green.

- [ ] **Step 5: Run the full suite (existing + relocated)**

```bash
pnpm test
```
Expected: every suite green — the 9 existing push-hub suites plus the 5 relocated engine suites (full run needs the test-DB precondition; see Global Constraints). Step 4 above is the DB-independent proof that the relocation itself is correct.

- [ ] **Step 6: Commit**

```bash
git add test/engine
git commit -m "test: relocate engine unit tests into test/engine and repoint specifiers"
```

---

## Task 3: Simplify the Dockerfile

**Files:**
- Modify: `Dockerfile` (remove `RUN apk add --no-cache git` + git-dep comments)

**Interfaces:**
- Consumes: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` from Task 1 (the frozen-lockfile install must match the regenerated lockfile).
- Produces: nothing downstream.

- [ ] **Step 1: Replace the Dockerfile**

`git` existed solely to clone the git-dependency at install time; the engine is now local source with no git deps. Remove `RUN apk add --no-cache git` and its explanatory comment, and trim the `COPY` comment so it no longer references the git-dep clone/`allowBuilds`-for-git-dep rationale — but keep the reason `pnpm-workspace.yaml` is copied (it still carries `esbuild`'s allowBuild) and keep the single-stage CMD note. Replace the entire file with:
```dockerfile
FROM node:22-alpine

WORKDIR /app

# pnpm-workspace.yaml must be copied alongside the manifests, before install: its
# `allowBuilds` allowlist for `esbuild` is what lets pnpm run esbuild's native
# postinstall build. Without it here, pnpm silently skips that build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN corepack enable && corepack prepare pnpm@11.5.0 --activate
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

EXPOSE 3000

# Single-stage on purpose: the deploy migrate step runs `pnpm db:migrate`
# (tsx src/migrate.ts) against this same image, so devDependencies and src/
# must stay in the final image — do not slim this to a prod-deps-only stage.
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Verify git is gone and the frozen-lockfile install is coherent**

```bash
grep -n "apk add" Dockerfile && echo "FAIL: apk add still present" || echo "OK: no apk add"
corepack prepare pnpm@11.5.0 --activate && pnpm install --frozen-lockfile
```
Expected: `OK: no apk add`; `pnpm install --frozen-lockfile` succeeds with no lockfile-mismatch error (proves the Task 1 lockfile matches the manifest under the pinned pnpm the Docker build uses).

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "build: drop git from Dockerfile now that the engine is local source"
```

---

## Task 4: Vendor the integration guide and update the README

**Files:**
- Create: `docs/engine-integration.md` (adapted copy of the engine's INTEGRATION.md)
- Modify: `README.md` (lines ~4 and ~140-141)

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing downstream.

A verbatim copy of INTEGRATION.md is NOT self-contained — it is written for external npm consumers of the published package. The three `@tsteil/push-service` occurrences (verified: lines 1, 116, 200 — the only ones in the file) must be adapted so the copy stands on its own and the final grep passes.

- [ ] **Step 1: Copy INTEGRATION.md into the push-hub docs**

```bash
cp /Users/taylor/dev/push-service/docs/INTEGRATION.md docs/engine-integration.md
```

- [ ] **Step 2: Retitle the heading (line 1)**

Replace:
```markdown
# Integrating `@tsteil/push-service`
```
with:
```markdown
# push-hub's built-in push engine (`src/engine/`)
```

- [ ] **Step 3: Repoint the import example (line ~116) to the internal module**

The example currently shows an external package import. Replace:
```ts
import { createPushService, type PushTarget } from '@tsteil/push-service'
```
with the internal import that push-hub actually uses (nothing imports the engine as a package anymore; `src/registry.ts` is the only importer, via `./engine/index.js`):
```ts
// push-hub imports the engine internally; src/registry.ts is the only importer.
import { createPushService, type PushTarget } from './engine/index.js'
```

- [ ] **Step 4: Relabel the comparison-table column (line ~200)**

Replace the table header row:
```markdown
| Concern | `expo-server-sdk` | `@tsteil/push-service` |
```
with:
```markdown
| Concern | `expo-server-sdk` | push-hub engine (`src/engine`) |
```

- [ ] **Step 5: Verify the adapted doc is self-contained**

```bash
grep -n "@tsteil/push-service\|tayl0r/push-service" docs/engine-integration.md && echo "FAIL: package refs remain" || echo "OK: self-contained"
```
Expected: `OK: self-contained`.

- [ ] **Step 6: Update the README's top-of-file engine reference (line ~4)**

`README.md` lines 3-5 currently read:
```markdown
A self-hosted, multi-tenant push-notification service. It owns the `user → device
tokens` mapping and sends **by user id**, using [`@tsteil/push-service`](https://github.com/tayl0r/push-service)
as its APNs/FCM sending engine.
```
Reword to describe the built-in engine (no external package):
```markdown
A self-hosted, multi-tenant push-notification service. It owns the `user → device
tokens` mapping and sends **by user id**, using its built-in APNs/FCM engine
(`src/engine/`).
```

- [ ] **Step 7: Repoint the README integration-guide link (lines ~140-141)**

`README.md` lines 140-143 currently read:
```markdown
See [`@tsteil/push-service`](https://github.com/tayl0r/push-service)'s
[integration guide](https://github.com/tayl0r/push-service/blob/main/docs/INTEGRATION.md)
for how native tokens and provider credentials work; push-hub moves the storage, fan-out,
and cleanup server-side, shared across apps.
```
Repoint to the local guide:
```markdown
See the built-in engine's [integration guide](docs/engine-integration.md) for how native
tokens and provider credentials work; push-hub moves the storage, fan-out, and cleanup
server-side, shared across apps.
```

- [ ] **Step 8: Verify the README no longer references the package**

```bash
grep -n "@tsteil/push-service\|tayl0r/push-service" README.md && echo "FAIL: refs remain" || echo "OK: clean"
```
Expected: `OK: clean`.

- [ ] **Step 9: Commit**

```bash
git add docs/engine-integration.md README.md
git commit -m "docs: vendor the engine integration guide and update README references"
```

---

## Final Verification (run after all tasks)

Run from the worktree root with the pinned pnpm active.

- [ ] **`pnpm install` succeeds and the lockfile is settled**

```bash
corepack prepare pnpm@11.5.0 --activate && pnpm install
```
Expected: succeeds; no further lockfile changes.

- [ ] **Build is clean (no dangling `@tsteil/push-service` resolution)**

```bash
pnpm build
```
Expected: `tsc` clean.

- [ ] **Full test suite green (existing push-hub + 5 relocated engine suites)**

```bash
pnpm test
```
Expected: all suites pass (full run needs the test-DB precondition — see Global Constraints; `pnpm test -- test/engine` is the DB-independent check for the relocated engine suites).

- [ ] **Scoped grep over the functional + user-facing surface returns nothing**

This is deliberately scoped — do NOT run a `docs/`-wide grep (it always matches the immutable planning history under `docs/superpowers/` and can never pass).
```bash
grep -rn '@tsteil/push-service\|tayl0r/push-service' \
  src/ test/ package.json pnpm-workspace.yaml Dockerfile pnpm-lock.yaml README.md docs/engine-integration.md
```
Expected: no output.

- [ ] **CI note (informational):** on push to `main`, CI builds `:dev` and deploys to `push-hub-dev.tsteil.com` first before any prod promotion — the safe surface for any Dockerfile breakage.
