---
dev-flow:
  slug: gh-11-engine-partial-send-results
  spec: docs/superpowers/specs/2026-07-23-gh-11-engine-partial-send-results-design.md
---

# Engine: partial send results — a config fault must not discard the batch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use markdown checkbox syntax for tracking — tick each one as it completes.

**Goal:** Make `engine.send()` resolve with exactly one `SendResult` per input target on every path, so a single config-classified per-token provider fault can no longer discard an entire `/v1/send` batch's results (sibling transport included), while keeping the fault loud on the observability plane.

**Architecture:** Three new first-class members join the `SendStatus` union — `config` (a configured provider's credentials/topic are broken), `unconfigured` (the tenant has no credentials for that provider at all), and `error` (a push-hub defect backstop). The transports stop throwing on `config` and instead map every per-target throw to a result through a new **required** `onError(item, error) => R` argument on `mapWithConcurrency`, which makes "one result per item" structural rather than conventional. `createPushService` wraps each transport call in a `runTransport` helper that synthesizes per-target results for a missing transport (`unconfigured`) or a transport-level rejection (`error`), so neither branch of its `Promise.all` can ever reject. `POST /v1/send` needs no change to its ticket-building or cleanup code — it only gains per-request Sentry/log reporting for the `config`, `error` and `unconfigured` batches.

**Tech Stack:** TypeScript (strict, NodeNext), Node ≥22, pnpm, Fastify 5, Drizzle ORM + postgres-js, prom-client, `@sentry/node`, vitest 2, `apns2`, `google-auth-library`.

## Global Constraints

- **Design authority:** `docs/superpowers/specs/2026-07-23-gh-11-engine-partial-send-results-design.md`. This plan implements it as written. Do not redesign. If a task's code disagrees with the design, the design wins — stop and report.
- **Repo root:** `/Users/taylor/dev/push-hub`. Work in place on the already-checked-out branch `tayl0r/gh-11-engine-partial-send-results`. Never run `git switch` / `git checkout` / `git branch` / `git stash`.
- **Build:** `pnpm build` (`tsc -p tsconfig.json`). Compiles `src` only — tests are not typechecked by the build.
- **Tests:** `pnpm test` (`vitest run`). `TEST_DATABASE_URL` must be set for the DB suites; it is already set in this environment to `postgres://postgres:postgres@localhost:5435/pushhub_test`. `fileParallelism: false`.
- **No new dependencies, no schema migration, no new env var, no compose/Dockerfile change.** Code + tests + docs only.
- **No response-shape change.** `POST /v1/send` keeps `{ "data": [ { userId, status: "ok" | "error", error? } ] }`. No `207`, no new ticket field, no new envelope.
- **Never log or send to Sentry:** device tokens, `ref`s, or user ids. Only `tenant`, `providers`, `reasons`, `failed`, `total`, `count`.
- **`retryable` stays absent** on `config`, `unconfigured` and `error` results (matching `invalid`); only `failed` sets it.
- **Exact new status strings** (copy verbatim, they are compared by equality in `src/routes/send.ts`): `'config'`, `'unconfigured'`, `'error'`.
- **Exact new reason-string prefixes** (copy verbatim): `'provider not configured'` for `unconfigured`, and `` `transport error: ${...}` `` for the backstop `error`.
- **Commit after every task.** Do not push, do not open a PR, do not create issues — a later pipeline stage owns that.
- **Line citations:** every `file:line` number in this plan cites the pre-plan tree (the branch's starting commit). Steps that edit a file this plan has already touched anchor on quoted content instead of line numbers — wherever a number and the quoted content disagree, the quoted content wins.

## File Structure

| File | Change | Responsibility after this plan |
|---|---|---|
| `src/engine/types.ts` | Modify (`:18`) | Owns the `SendStatus` union — now six members, each documented with its "who may emit it / what a consumer does" contract. |
| `src/engine/concurrency.ts` | Modify (`:5-21`) | `mapWithConcurrency` owns the *total mapping* property: every input item yields exactly one output slot, throwing or not. `retryTransient` and `sleep` untouched. |
| `src/engine/apns.ts` | Modify (`:41-58`) | APNs happy path + an `onError` mapper that classifies an APNs throw into `config` / `invalid` / `failed`. No `try/catch` of its own. |
| `src/engine/fcm.ts` | Modify (`:51-82`) | Same shape for FCM. `accessToken()`'s `config` throw (`:34`) now surfaces through `onError`. |
| `src/engine/index.ts` | Modify (`:1-28`) | Orchestrator: fan targets out by provider, `runTransport` synthesizes `unconfigured` (no transport) and `error` (transport rejected) per-target results, so `send()` can never reject for a per-token reason. |
| `src/routes/send.ts` | Modify (`:9-57`) | Route: unchanged ticket/cleanup logic, plus module-scope `ProviderConfigError` / `PushTransportDefect` / `distinct`, plus three per-request report blocks and one corrected log string. |
| `vitest.config.ts` | Modify (`:3-8`) | Adds `clearMocks: true` so every mock's call history resets before each test. |
| `test/engine/concurrency.test.ts` | Modify | Pins the `onError` contract at the unit level. |
| `test/engine/apns.test.ts` | Modify | Pins `config`-as-a-result and sibling preservation for APNs. |
| `test/engine/fcm.test.ts` | Modify | Same for FCM, plus the no-access-token and 403-without-detail cases. |
| `test/engine/index.test.ts` | Modify | Pins the one-result-per-target invariant and the emission split (`unconfigured` only from the missing-transport branch, `error` only from the backstop). |
| `test/send.route.test.ts` | Modify | Pins the HTTP contract: `200` + tickets + cleanup on a config fault, one Sentry event per request, unconfigured is silent. |
| `README.md` | Modify (~`:68-71`) | Tells callers to read tickets, not the status code. |
| `docs/engine-integration.md` | Modify (`:23`, `:136-159`, `:209-210`) | Teaches the six-status model and the never-rejects invariant. |

Nothing is created; nothing is deleted.

## Task Ordering & the `mapWithConcurrency` breaking change

`mapWithConcurrency` gains a **required** fourth parameter (design §3). Both transports call it, so the signature change is a compile break at two call sites. **The tree is kept compilable and green at every task boundary** by having Task 2 land the signature change *together with* a one-line temporary rethrowing shim at each call site:

```ts
(_target, e): SendResult => { throw e }
```

That shim reproduces today's behavior bit-for-bit (a throw from `fn` propagates out of `mapWithConcurrency`, exactly as before), so every existing transport test stays green after Task 2. Task 3 replaces the APNs shim with the real mapper; Task 4 replaces the FCM one. After Task 4 no shim remains — **if you finish this plan and `git grep 'throw e'` still matches anything in `src/engine/apns.ts` or `src/engine/fcm.ts`, a shim was left behind.** (`src/engine/concurrency.ts` keeps its one legitimate, permanent `throw e` inside `retryTransient` — the retry-exhaustion path. It is not a shim; do not remove it.)

Dependency order: **1 → 2 → 3 → 4 → 5 → 6 → 7**. Tasks 3 and 4 are independent of each other (different files, different tests) and may be done in either order, but both require Tasks 1 and 2.

---

### Task 1: Foundation — widen `SendStatus`, enable `clearMocks`

Pure enablers, no behavior change. The union must exist before any task can write `status: 'config'`; `clearMocks` must exist before Task 6's module-scoped Sentry mock can assert zero-call cases order-independently. Landing both first also proves early that the whole suite is green under `clearMocks`.

**Files:**
- Modify: `src/engine/types.ts:18`
- Modify: `vitest.config.ts:3-8`
- Modify: `test/engine/fcm.test.ts:1,19` (drop the now-redundant `getAccessToken.mockClear()` hook)
- Modify: `test/engine/index.test.ts:1,36` (drop the now-redundant `apnsClose/fcmClose.mockClear()` hook)

**Interfaces:**
- Consumes: nothing.
- Produces: `export type SendStatus = 'delivered' | 'failed' | 'invalid' | 'config' | 'unconfigured' | 'error'` in `src/engine/types.ts`. `SendResult` is unchanged: `{ ref?: string; token: string; provider: Provider; status: SendStatus; retryable?: boolean; error?: string }`. Every later task writes and compares these exact string literals.

- [x] **Step 1: Widen the union in `src/engine/types.ts`**

Replace line 18 (`export type SendStatus = 'delivered' | 'failed' | 'invalid'`) with:

```ts
/**
 * delivered    — the provider accepted the push for this token.
 * failed       — transient or unknown per-token failure; keep the token, retry is the caller's call.
 * invalid      — the token is dead; delete it.
 * config       — the tenant's CONFIGURED provider credentials/topic are broken (expired .p8,
 *                401/403, bad topic). Nothing is wrong with the token — never delete it — and
 *                no retry helps until a human fixes the credentials. Operator-loud: this is an incident.
 * unconfigured — the tenant has no credentials for this target's provider at all (routine, e.g.
 *                Android tokens registered mid-rollout before FCM creds land). Keep the token.
 *                Observable, never paged: a state, not an incident.
 * error        — defect backstop only: a transport rejected instead of returning results.
 *                Outcome unknown; keep the token. A push-hub bug, never a tenant problem.
 */
export type SendStatus = 'delivered' | 'failed' | 'invalid' | 'config' | 'unconfigured' | 'error'
```

Leave `SendResult` (lines 20-27) exactly as it is.

- [x] **Step 2: Verify the widening is not a compile break**

Run: `cd /Users/taylor/dev/push-hub && pnpm build`
Expected: exits 0, no output. (Every consumer in `src/` branches on equality, never on an exhaustive `switch` — the three consumer sites are `src/routes/send.ts:45`, `:49`, `:53-54`, and `recordSend` takes `status: string`.)

- [x] **Step 3: Add `clearMocks: true` to `vitest.config.ts`**

Replace the whole file with:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    clearMocks: true,                       // reset every mock's call history before each test — zero-call assertions must not depend on test order
    fileParallelism: false,                 // DB test files share one push_tokens table + TRUNCATE between cases — serialize files so they can't race
    globalSetup: './test/global-setup.ts',  // migrate TEST_DATABASE_URL once before any suite (no-op when unset)
    setupFiles: ['./test/setup.ts'],        // per-file hooks: zero metric values before every test
  },
})
```

`clearMocks` clears call history only. Every existing `mockReset()` hook **stays** (`test/send.route.test.ts:24`, `test/app.test.ts:19`, `test/engine/apns.test.ts:43`) — only `mockReset` discards a persistent `mockImplementation` / `mockRejectedValue` left by a previous case.

- [x] **Step 4: Drop the two hooks `clearMocks` makes redundant**

In `test/engine/fcm.test.ts`, delete line 19 entirely:

```ts
beforeEach(() => { getAccessToken.mockClear() })
```

and change line 1 from `import { describe, it, expect, vi, beforeEach } from 'vitest'` to:

```ts
import { describe, it, expect, vi } from 'vitest'
```

In `test/engine/index.test.ts`, delete the `beforeEach` line inside the `describe` (line 36):

```ts
  beforeEach(() => { apnsClose.mockClear(); fcmClose.mockClear() })
```

and change line 1 from `import { describe, it, expect, vi, beforeEach } from 'vitest'` to:

```ts
import { describe, it, expect, vi } from 'vitest'
```

Leave `test/registry.test.ts:30` and `test/tenants.route.test.ts:33` alone — those hooks also do DB `TRUNCATE`s.

- [x] **Step 5: Run the full suite to prove `clearMocks` changed no assertion**

Run: `cd /Users/taylor/dev/push-hub && pnpm test`
Expected: PASS — the same test count as before this task, zero failures. In particular `test/engine/fcm.test.ts` and `test/engine/index.test.ts` still pass with their hooks removed, and `test/engine/apns.test.ts`'s retry tests (which assert `toHaveBeenCalledTimes(2)` / `(3)`) still pass because each reads calls made inside its own `it()`.

- [x] **Step 6: Commit**

```bash
cd /Users/taylor/dev/push-hub
git add src/engine/types.ts vitest.config.ts test/engine/fcm.test.ts test/engine/index.test.ts
git commit -m "feat(engine): widen SendStatus with config/unconfigured/error; enable vitest clearMocks"
```

---

### Task 2: `mapWithConcurrency` requires an `onError` mapper

Make "no per-item throw may discard the batch" a property of the shared mapper's signature rather than hand-maintained `try/catch` discipline duplicated per transport. The parameter is **required**, not optional, so a future third caller gets a compile error instead of silently reintroducing this bug.

**Files:**
- Modify: `src/engine/concurrency.ts:5-21`
- Modify: `src/engine/apns.ts:42,57` (temporary rethrow shim — replaced in Task 3)
- Modify: `src/engine/fcm.ts:52,81` (temporary rethrow shim — replaced in Task 4)
- Test: `test/engine/concurrency.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this task is type-independent of the union).
- Produces:
  ```ts
  export async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
    onError: (item: T, error: unknown) => R,
  ): Promise<R[]>
  ```
  Contract: resolves an array of `items.length` results in input order. If `fn` rejects for item `i`, slot `i` holds `onError(items[i], error)` and every other slot holds its real result. The returned promise rejects **only** if `onError` itself throws.
  `sleep` and `retryTransient` keep their current signatures and are untouched.

- [x] **Step 1: Update the existing concurrency test for the fourth argument and write the failing new test**

Replace the whole `describe('mapWithConcurrency', ...)` block in `test/engine/concurrency.test.ts` (lines 4-16) with:

```ts
describe('mapWithConcurrency', () => {
  it('preserves order and caps in-flight count', async () => {
    let inFlight = 0, maxInFlight = 0
    const fn = async (n: number) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--; return n * 2
    }
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, fn, () => 0 /* unreachable: fn never throws */)
    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  // The unit-level proof of the property both transports and the orchestrator depend on:
  // a throwing item costs exactly its own slot and never the batch.
  it('maps a throwing item via onError in place, siblings keep their results, and it resolves', async () => {
    const fn = async (n: number) => { if (n === 2) throw new Error('boom'); return n * 2 }
    const out = await mapWithConcurrency([1, 2, 3], 2, fn, (n: number) => -n)
    expect(out).toEqual([2, -2, 6])
  })

  it('returns [] for an empty input without calling fn', async () => {
    const fn = vi.fn(async (n: number) => n)
    expect(await mapWithConcurrency([], 4, fn, () => 0)).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })
})
```

`vi` is already imported on line 1 of that file. Leave the `describe('retryTransient', ...)` block untouched.

- [x] **Step 2: Run the concurrency test to verify it fails**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/engine/concurrency.test.ts`
Expected: FAIL — "maps a throwing item via onError in place…" rejects with `Error: boom` (today `mapWithConcurrency` has no `try/catch`, so the worker's rejection propagates).

- [x] **Step 3: Implement the new signature in `src/engine/concurrency.ts`**

Replace lines 5-21 (the whole `mapWithConcurrency` function) with:

```ts
/**
 * Map `items` with at most `limit` in flight, preserving input order.
 *
 * Total by construction: every item yields exactly one slot. A rejection from `fn`
 * is mapped in place by `onError` — it never discards a sibling's completed result
 * and never rejects the join. `onError` is REQUIRED so a new caller cannot skip the
 * question "what result does a thrown item produce?" (that omission is bug #11).
 * The only remaining reject path is `onError` itself throwing, i.e. a defect.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onError: (item: T, error: unknown) => R,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const idx = next++
      try {
        results[idx] = await fn(items[idx]!)
      } catch (e) {
        results[idx] = onError(items[idx]!, e)
      }
    }
  }
  const size = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: size }, worker))
  return results
}
```

Leave `sleep` (lines 1-3) and `retryTransient` (lines 23-38) exactly as they are.

- [x] **Step 4: Add the temporary rethrow shims so the tree still compiles**

These two shims preserve today's exact behavior (a throw from `fn` still propagates out of `mapWithConcurrency`) and exist for one commit each. Task 3 deletes the APNs one; Task 4 deletes the FCM one. Nothing else in either file changes in this task.

In `src/engine/apns.ts`, the `send` method currently ends at line 57 with the line `    })` — the two characters that close the callback arrow and the `mapWithConcurrency` call. Replace **only that line** with:

```ts
    // TEMPORARY (removed in the next task): rethrowing keeps today's fail-loud behavior byte-for-byte
    // while the mapper's new required argument lands.
    }, (_target, e): SendResult => { throw e })
```

In `src/engine/fcm.ts`, the `send` method ends the same way at line 81 with `    })`. Replace **only that line** with:

```ts
    // TEMPORARY (removed in the next task): see the note in apns.ts.
    }, (_target, e): SendResult => { throw e })
```

`SendResult` is already imported (type-only) in both files, so no import changes are needed.

- [x] **Step 5: Verify the build and the full suite are green**

Run: `cd /Users/taylor/dev/push-hub && pnpm build && pnpm test`
Expected: build exits 0; PASS on every file. `test/engine/concurrency.test.ts` now has 3 passing `mapWithConcurrency` cases, and every APNs/FCM/orchestrator test still passes unchanged — the shims mean no observable behavior moved in this task.

- [x] **Step 6: Commit**

```bash
cd /Users/taylor/dev/push-hub
git add src/engine/concurrency.ts src/engine/apns.ts src/engine/fcm.ts test/engine/concurrency.test.ts
git commit -m "feat(engine): mapWithConcurrency requires an onError mapper — a throwing item can no longer discard the batch"
```

---

### Task 3: APNs transport — a config fault becomes a `config` result

Delete the APNs throw site (`src/engine/apns.ts:53`, `if (c.kind === 'config') throw e`) by moving the whole per-target `catch` body into the `onError` mapper, with the `throw e` replaced by a `config` result.

**Files:**
- Modify: `src/engine/apns.ts:41-58`
- Test: `test/engine/apns.test.ts:64-68` (rewrite) + one new case

**Interfaces:**
- Consumes: `SendStatus` including `'config'` (Task 1); `mapWithConcurrency(items, limit, fn, onError)` (Task 2).
- Produces: `ApnsTransport.send(targets: PushTarget[], n: PushNotification): Promise<SendResult[]>` — unchanged signature, but it now **never rejects for a per-target reason**. Emits only `delivered | failed | invalid | config`; never `unconfigured`, never `error`.

- [x] **Step 1: Write the failing tests**

In `test/engine/apns.test.ts`, replace lines 64-68 (the `'InvalidProviderToken → throws (fail-loud)'` case) with these two cases:

```ts
  it('InvalidProviderToken → a config result, not a throw', async () => {
    send.mockRejectedValue(apnsError('InvalidProviderToken', 403))
    const t = new ApnsTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'apns', ref: 'r-cfg' }], note)
    expect(r).toMatchObject({ ref: 'r-cfg', provider: 'apns', status: 'config', error: 'InvalidProviderToken' })
    expect(r!.retryable).toBeUndefined() // config is not retryable — absent, matching `invalid`
  })

  it('a config fault on one target does not discard its siblings', async () => {
    // Keyed on the notification's deviceToken, NOT on call order: the 3 targets are dispatched
    // concurrently, so a mockRejectedValueOnce chain would depend on worker scheduling.
    send.mockImplementation(async (n: any) => {
      if (n.deviceToken === 'bad') throw apnsError('ExpiredProviderToken', 403)
      return undefined
    })
    const t = new ApnsTransport(config)
    const results = await t.send([
      { token: 'ok1', provider: 'apns', ref: 'r1' },
      { token: 'bad', provider: 'apns', ref: 'r2' },
      { token: 'ok2', provider: 'apns', ref: 'r3' },
    ], note)
    expect(results).toHaveLength(3)
    expect(results.map(r => r.status)).toEqual(['delivered', 'config', 'delivered'])
    expect(results.map(r => r.ref)).toEqual(['r1', 'r2', 'r3'])
    expect(results[1]!.error).toBe('ExpiredProviderToken')
  })
```

(The mocked `Notification` class at `test/engine/apns.test.ts:23` stores the token as its `deviceToken` field, which is what the keyed `mockImplementation` reads.)

- [x] **Step 2: Run the APNs tests to verify they fail**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/engine/apns.test.ts`
Expected: FAIL — both new cases reject with the `ApnsError` (`APNS Error: 403 - InvalidProviderToken` / `- ExpiredProviderToken`) instead of resolving, because the transport still rethrows on `config` and the Task 2 shim propagates it.

- [x] **Step 3: Move the catch body into `onError` in `src/engine/apns.ts`**

Replace the whole `send` method — everything from the `async send(targets: PushTarget[], n: PushNotification)` line through the method's closing `}`, including the Task 2 shim — with:

```ts
  async send(targets: PushTarget[], n: PushNotification): Promise<SendResult[]> {
    return mapWithConcurrency(
      targets,
      CONCURRENCY,
      async (target) => {
        await retryTransient(
          () => this.client.send(this.notification(target, n)),
          (e) => e instanceof ApnsError && classifyApns(e.reason).kind === 'transient',
        )
        return { ref: target.ref, token: target.token, provider: 'apns', status: 'delivered' }
      },
      // Every per-target throw — classified provider error, network failure, or a future bug in
      // the callback — becomes exactly one SendResult here. A config fault is reported as a
      // `config` result, never a throw: loudness lives on the observability plane (see #11).
      (target, e): SendResult => {
        const c = e instanceof ApnsError ? classifyApns(e.reason) : { kind: 'failed' as const }
        const reason = e instanceof ApnsError ? e.reason : e instanceof Error ? e.message : String(e)
        if (c.kind === 'config') return { ref: target.ref, token: target.token, provider: 'apns', status: 'config', error: reason }
        if (c.kind === 'invalid') return { ref: target.ref, token: target.token, provider: 'apns', status: 'invalid', error: reason }
        return { ref: target.ref, token: target.token, provider: 'apns', status: 'failed', retryable: c.kind === 'transient', error: reason }
      },
    )
  }
```

Notes for the implementer: the old per-target `reasonOf` closure (old line 43) is inlined into `onError` above and no longer exists; there is no `try` block left in this file's `send`. `retryTransient` is untouched — `config` is not `transient`, so its predicate is already false and a config fault still costs exactly one provider round-trip per target.

- [x] **Step 4: Run the APNs tests to verify they pass**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/engine/apns.test.ts`
Expected: PASS — all cases, including the unchanged `BadDeviceToken → invalid`, the two retry cases, and the two new ones.

- [x] **Step 5: Verify the APNs throw site is gone, then build and run the full suite**

Run: `cd /Users/taylor/dev/push-hub && git grep -n 'throw e' -- src/engine/apns.ts`
Expected: **no matches** (exit code 1) — both the old `config` throw site and the Task 2 shim are gone from this file. Scoped to `apns.ts` on purpose: `src/engine/fcm.ts` still matches if Task 4 has not run yet, and `retryTransient`'s `throw e` in `src/engine/concurrency.ts` is legitimate and stays.

Run: `cd /Users/taylor/dev/push-hub && pnpm build && pnpm test`
Expected: build exits 0; **every test file PASS, zero failures.** In particular `test/engine/index.test.ts`'s `'propagates a transport config error (fail-loud) out of send()'` still passes even though it asserts a rejection — that file mocks the `ApnsTransport` / `FcmTransport` classes wholesale, so it never runs the real APNs code this task changed. (That case is rewritten in Task 5.) If anything fails here, stop and investigate before committing.

- [x] **Step 6: Commit**

```bash
cd /Users/taylor/dev/push-hub
git add src/engine/apns.ts test/engine/apns.test.ts
git commit -m "feat(engine): APNs config faults return a config SendResult instead of throwing"
```

---

### Task 4: FCM transport — a config fault becomes a `config` result

Same change for FCM: delete the throw site at `src/engine/fcm.ts:77` by moving the `catch` body into `onError`. The `no access token` throw at `src/engine/fcm.ts:34` **stays a throw** — it is raised inside `attempt`, so it now surfaces in `onError`, whose `FcmError` branch classifies it `config` for that one target.

**Files:**
- Modify: `src/engine/fcm.ts:51-82`
- Test: `test/engine/fcm.test.ts:60-66` (rewrite) + three new cases

**Interfaces:**
- Consumes: `SendStatus` including `'config'` (Task 1); `mapWithConcurrency(items, limit, fn, onError)` (Task 2).
- Produces: `FcmTransport.send(targets: PushTarget[], n: PushNotification): Promise<SendResult[]>` — unchanged signature, never rejects for a per-target reason. Emits only `delivered | failed | invalid | config`.

- [x] **Step 1: Write the failing tests**

In `test/engine/fcm.test.ts`, replace the whole `'401 UNAUTHENTICATED → throws (fail-loud config error)'` case with these four cases:

```ts
  it('401 UNAUTHENTICATED → a config result, not a throw', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {
      error: { code: 401, status: 'UNAUTHENTICATED', message: 'request had invalid authentication credentials' },
    }))
    const t = new FcmTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'fcm', ref: 'r-cfg' }], note)
    expect(r).toMatchObject({ ref: 'r-cfg', provider: 'fcm', status: 'config', error: 'UNAUTHENTICATED' })
    expect(r!.retryable).toBeUndefined()
  })

  // A 403 carrying errorCode SENDER_ID_MISMATCH classifies `invalid` (classify.ts checks the
  // FCM code BEFORE the status-code rule), so this fixture deliberately omits details[] to
  // exercise the config branch.
  it('403 PERMISSION_DENIED with no FcmError detail → a config result', async () => {
    vi.stubGlobal('fetch', mockFetch(403, {
      error: { code: 403, status: 'PERMISSION_DENIED', message: 'the caller does not have permission' },
    }))
    const t = new FcmTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'fcm', ref: 'r-403' }], note)
    expect(r).toMatchObject({ status: 'config', error: 'PERMISSION_DENIED' })
  })

  // Pins src/engine/fcm.ts's `no access token` throw: it is raised inside `attempt`, so it
  // must be routed through onError's FcmError branch rather than escaping send().
  it('no access token → a config result', async () => {
    getAccessToken.mockResolvedValueOnce({ token: undefined } as any)
    vi.stubGlobal('fetch', mockFetch(200, {}))
    const t = new FcmTransport(config)
    const [r] = await t.send([{ token: 'tok', provider: 'fcm', ref: 'r-tok' }], note)
    expect(r).toMatchObject({ status: 'config', error: 'no access token' })
  })

  it('a config fault on one target does not discard its siblings', async () => {
    // Keyed on the request body's message.token, NOT on call order — targets run concurrently.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const token = JSON.parse(init.body).message.token
      if (token === 'bad') {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad creds' } }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ name: 'projects/proj/messages/1' }) }
    }))
    const t = new FcmTransport(config)
    const results = await t.send([
      { token: 'ok1', provider: 'fcm', ref: 'r1' },
      { token: 'bad', provider: 'fcm', ref: 'r2' },
      { token: 'ok2', provider: 'fcm', ref: 'r3' },
    ], note)
    expect(results).toHaveLength(3)
    expect(results.map(r => r.status)).toEqual(['delivered', 'config', 'delivered'])
    expect(results.map(r => r.ref)).toEqual(['r1', 'r2', 'r3'])
    expect(results[1]!.error).toBe('UNAUTHENTICATED')
  })
```

The `getAccessToken` mock is declared at `test/engine/fcm.test.ts:3` as `vi.fn(async () => ({ token: 'oauth-token' }))`; `clearMocks` (Task 1) clears its call history but keeps that default implementation, and `mockResolvedValueOnce` applies to a single call.

- [x] **Step 2: Run the FCM tests to verify they fail**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/engine/fcm.test.ts`
Expected: FAIL on all four new cases — each rejects (`UNAUTHENTICATED` / `PERMISSION_DENIED` / `no access token`) instead of resolving with a result.

- [x] **Step 3: Move the catch body into `onError` in `src/engine/fcm.ts`**

Replace the whole `send` method — everything from the `async send(targets: PushTarget[], n: PushNotification)` line through the method's closing `}`, including the Task 2 shim — with:

```ts
  async send(targets: PushTarget[], n: PushNotification): Promise<SendResult[]> {
    return mapWithConcurrency(
      targets,
      CONCURRENCY,
      async (target) => {
        const attempt = async () => {
          const token = await this.accessToken()
          const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: this.body(target, n),
          })
          if (res.ok) return
          const payload = (await res.json().catch(() => ({}))) as {
            error?: { status?: string; message?: string; details?: Array<{ '@type'?: string; errorCode?: string }> }
          }
          // The FCM-specific code lives in details[].errorCode (@type …v1.FcmError), not error.status.
          const detail = payload.error?.details?.find(
            d => d['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
          )
          const fcmCode = detail?.errorCode ?? payload.error?.status
          throw new FcmError(classifyFcm(res.status, fcmCode), fcmCode ?? `HTTP ${res.status}`)
        }
        await retryTransient(attempt, (e) => e instanceof FcmError && e.classification.kind === 'transient')
        return { ref: target.ref, token: target.token, provider: 'fcm', status: 'delivered' }
      },
      // Every per-target throw becomes exactly one SendResult here — including accessToken()'s
      // `no access token` FcmError, which is raised inside `attempt` and classified `config`.
      (target, e): SendResult => {
        const c = e instanceof FcmError ? e.classification : { kind: 'failed' as const }
        const reason = e instanceof Error ? e.message : String(e)
        if (c.kind === 'config') return { ref: target.ref, token: target.token, provider: 'fcm', status: 'config', error: reason }
        if (c.kind === 'invalid') return { ref: target.ref, token: target.token, provider: 'fcm', status: 'invalid', error: reason }
        return { ref: target.ref, token: target.token, provider: 'fcm', status: 'failed', retryable: c.kind === 'transient', error: reason }
      },
    )
  }
```

Do **not** change `accessToken()` (lines 31-36) or `body()` (lines 38-49) — `throw new FcmError({ kind: 'config' }, 'no access token')` stays exactly as it is.

- [x] **Step 4: Run the FCM tests to verify they pass**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/engine/fcm.test.ts`
Expected: PASS on every case, including the unchanged 404/UNREGISTERED-invalid, 400/INVALID_ARGUMENT-failed, the two 503 retry cases, and the 404-without-detail case.

- [x] **Step 5: Verify no shim survived, then build and run the full suite**

Run: `cd /Users/taylor/dev/push-hub && git grep -n 'throw e' -- src/engine/fcm.ts`
Expected: **no matches** (exit code 1) — both the old `config` throw site and the Task 2 shim are gone from this file. Scoped to `fcm.ts` on purpose: `src/engine/apns.ts` still matches if Task 3 has not run yet, and the `throw e` inside `retryTransient` in `src/engine/concurrency.ts` is legitimate and permanent (the retry-exhaustion path — do NOT "fix" it; removing it breaks transient-retry exhaustion).

Run: `cd /Users/taylor/dev/push-hub && pnpm build && pnpm test`
Expected: build exits 0; all test files PASS. `test/engine/index.test.ts` still passes because it mocks both transport classes and its `apns-config-boom` mock rejects at the *transport* level, which Task 5 handles.

- [x] **Step 6: Commit**

```bash
cd /Users/taylor/dev/push-hub
git add src/engine/fcm.ts test/engine/fcm.test.ts
git commit -m "feat(engine): FCM config faults return a config SendResult instead of throwing"
```

---

### Task 5: Orchestrator — `runTransport` makes one-result-per-target structural

`createPushService` must not depend on the transports keeping their promise. Wrap each transport call so the invariant holds even when a transport rejects (a defect outside the per-target map, or `onError` itself throwing), and reclassify the missing-provider path from `failed` to `unconfigured`.

**Files:**
- Modify: `src/engine/index.ts:1-28`
- Test: `test/engine/index.test.ts` (mock header comment, `:51-58` update, `:83-92` rewrite, one new invariant case)

**Interfaces:**
- Consumes: `SendStatus` including `'unconfigured'` and `'error'` (Task 1); `ApnsTransport` / `FcmTransport` `send()` which never reject for a per-target reason (Tasks 3, 4).
- Produces: `createPushService(config: PushServiceConfig): PushService` where `send({ tokens, notification })` resolves with `SendResult[]` of exactly `tokens.length` entries, APNs results first then FCM results. `notConfigured` no longer exists; it is replaced by `synthesized(targets, status, error)`. **Emission split (an invariant later tasks and the alerting rules rely on):** `'unconfigured'` is produced *only* by the missing-transport branch, `'error'` *only* by the rejection backstop, and a transport's own results are never either.

- [x] **Step 1: Write the failing tests**

In `test/engine/index.test.ts`:

(a) Update the mock header comment on lines 4-5 from:

```ts
// convention in the token string so a single batch can mix delivered/failed/invalid, and
// a token of `<provider>-config-boom` makes the transport reject (fail-loud config error).
```

to:

```ts
// convention in the token string so a single batch can mix delivered/failed/invalid, and
// a token of `<provider>-config-boom` makes the whole transport REJECT — which after #11 is
// a push-hub defect, caught by the orchestrator's backstop, not a tenant config fault.
```

(b) Replace the whole `'returns "provider not configured" failed results when a provider is absent'` case with:

```ts
  it('returns "unconfigured" results when a provider is absent', async () => {
    const push = createPushService({ apns: {} as any }) // no fcm
    const results = await push.send({
      tokens: [{ token: 'b', provider: 'fcm', ref: 'r2' }],
      notification: note,
    })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: 'unconfigured', error: 'provider not configured', ref: 'r2' })
    // a missing provider is a routine rollout state — never the `config` incident status
    expect(results[0]!.status).not.toBe('config')
    expect(results[0]!.retryable).toBeUndefined()
  })
```

(c) Replace the whole `'propagates a transport config error (fail-loud) out of send()'` case with:

```ts
  it('a transport-level rejection never discards the sibling transport\'s results', async () => {
    const push = createPushService({ apns: {} as any, fcm: {} as any })
    const results = await push.send({
      tokens: [
        { token: 'apns-config-boom', provider: 'apns', ref: 'r1' },
        { token: 'ok-fcm', provider: 'fcm', ref: 'r2' },
      ],
      notification: note,
    })
    expect(results).toHaveLength(2)
    // a transport that REJECTS is a push-hub defect, not a tenant credential fault
    const backstopped = results.find(r => r.ref === 'r1')!
    expect(backstopped.status).toBe('error')
    expect(backstopped.error).toMatch(/^transport error: /)
    // …and the sibling transport's batch survives — the whole point of #11
    expect(results.find(r => r.ref === 'r2')).toMatchObject({ provider: 'fcm', status: 'delivered' })
  })

  it('resolves exactly one result per input target even when a transport rejects', async () => {
    const push = createPushService({ apns: {} as any, fcm: {} as any })
    const tokens = [
      { token: 'apns-config-boom', provider: 'apns' as const, ref: 'r1' },
      { token: 'ok-apns', provider: 'apns' as const, ref: 'r2' },
      { token: 'ok-fcm', provider: 'fcm' as const, ref: 'r3' },
      { token: 'dead-fcm', provider: 'fcm' as const, ref: 'r4' },
    ]
    const results = await push.send({ tokens, notification: note })

    expect(results).toHaveLength(tokens.length)
    expect(results.map(r => r.ref).sort()).toEqual(['r1', 'r2', 'r3', 'r4'])
    // the rejecting transport's whole batch is backstopped per target…
    expect(results.filter(r => r.provider === 'apns').every(r => r.status === 'error')).toBe(true)
    // …while the sibling transport keeps its real per-target outcomes
    expect(results.find(r => r.ref === 'r3')).toMatchObject({ status: 'delivered' })
    expect(results.find(r => r.ref === 'r4')).toMatchObject({ status: 'invalid' })
    // emission split: `unconfigured` comes only from the missing-transport branch, never from a transport
    expect(results.some(r => r.status === 'unconfigured')).toBe(false)
  })
```

Leave the `'routes each target to its provider and preserves refs'`, `'echoes every input ref across a mixed-provider, mixed-outcome batch'` and both `close()` cases exactly as they are.

- [x] **Step 2: Run the orchestrator tests to verify they fail**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/engine/index.test.ts`
Expected: FAIL — the unconfigured case sees `status: 'failed'`, and both rejection cases reject with `Error: config: bad .p8 signing key` instead of resolving.

- [x] **Step 3: Implement `runTransport` in `src/engine/index.ts`**

Replace the whole file with:

```ts
import { ApnsTransport } from './apns.js'
import { FcmTransport } from './fcm.js'
import type { PushNotification, PushService, PushServiceConfig, PushTarget, SendRequest, SendResult } from './types.js'

export * from './types.js'

export function createPushService(config: PushServiceConfig): PushService {
  const apns = config.apns ? new ApnsTransport(config.apns) : null
  const fcm = config.fcm ? new FcmTransport(config.fcm) : null

  const synthesized = (targets: PushTarget[], status: 'unconfigured' | 'error', error: string): SendResult[] =>
    targets.map(t => ({ ref: t.ref, token: t.token, provider: t.provider, status, error }))

  const runTransport = async (
    transport: { send(t: PushTarget[], n: PushNotification): Promise<SendResult[]> } | null,
    targets: PushTarget[],
    n: PushNotification,
  ): Promise<SendResult[]> => {
    if (!transport) return synthesized(targets, 'unconfigured', 'provider not configured')
    try {
      return await transport.send(targets, n)
    } catch (err) {
      // Backstop: after #11 a transport rejects only on a defect outside the per-target map
      // (or from onError itself). Convert to per-target results rather than reject the join —
      // a sibling transport's batch must never be collateral.
      return synthesized(targets, 'error', `transport error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    // Resolves exactly one SendResult per input target, always. Promise.all is safe here
    // precisely because runTransport absorbs rejections — it keeps the typed tuple destructure.
    async send({ tokens, notification }: SendRequest): Promise<SendResult[]> {
      const [a, f] = await Promise.all([
        runTransport(apns, tokens.filter(t => t.provider === 'apns'), notification),
        runTransport(fcm, tokens.filter(t => t.provider === 'fcm'), notification),
      ])
      return [...a, ...f]
    },
    async close(): Promise<void> {
      await Promise.all([apns?.close(), fcm?.close()])
    },
  }
}
```

No empty-target guard is needed: `mapWithConcurrency` already returns `[]` for an empty input (its `Math.max(1, …)` clamp gives one worker whose `while (next < items.length)` loop never runs).

- [x] **Step 4: Run the orchestrator tests to verify they pass**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/engine/index.test.ts`
Expected: PASS on every case in the file.

- [x] **Step 5: Verify the build and the full suite**

Run: `cd /Users/taylor/dev/push-hub && pnpm build && pnpm test`
Expected: build exits 0; every test file PASS. `test/send.route.test.ts`'s `'500 when the engine throws…'` case still passes — it mocks `engine.send` directly with `mockRejectedValueOnce`, so it exercises the route's own `catch`, not the engine.

- [x] **Step 6: Commit**

```bash
cd /Users/taylor/dev/push-hub
git add src/engine/index.ts test/engine/index.test.ts
git commit -m "feat(engine): orchestrator synthesizes per-target results for a missing or rejecting transport"
```

---

### Task 6: `/v1/send` — report config faults and defects loudly, keep returning tickets

The ticket-building and cleanup code needs **no change** (none of `config` / `unconfigured` / `error` is `'delivered'`, so each yields an `error` ticket; none is `'invalid'`, so none can delete a token). What is added is per-request observability: one Sentry event per affected request, structured logs, and a corrected log string on the pre-existing `catch`.

**Files:**
- Modify: `src/routes/send.ts` (module-scope additions after `sendBody`; three report blocks after the `recordSend` loop; one log-string fix at `:40`)
- Test: `test/send.route.test.ts` (hoisted Sentry mock; rename `:129-137`; four new cases)

**Interfaces:**
- Consumes: `SendResult.status` values `'config'`, `'unconfigured'`, `'error'` (Task 1), produced by the engine (Tasks 3-5).
- Produces: no exported symbol. `ProviderConfigError` and `PushTransportDefect` are **module-private** (not exported — nothing outside this route constructs or catches them) and set `name` explicitly so GlitchTip groups them under the dedicated type. `distinct(values: (string | undefined)[]): string[]` is module-private, maps `undefined` → `'unknown'` and returns a sorted, de-duplicated array.

- [x] **Step 1: Write the failing tests**

In `test/send.route.test.ts`, add the hoisted Sentry mock immediately after the import block (after line 11, `import { readSeries } from './helpers/metrics.js'`):

```ts
// The route captures to Sentry; without Sentry.init these are inert no-ops, so mock the module
// to assert on them. `vi.hoisted` gives the spy a handle the (hoisted) vi.mock factory can close over.
const captureException = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({ captureException }))
```

Rename the existing `'500 when the engine throws, and counts one error per attempted target by provider'` case — keep the body byte-for-byte, change only the title and add a clarifying comment:

```ts
  // This path is unreachable in normal operation after #11: a rejection out of engine.send means
  // push-hub itself is broken, NOT that a tenant misconfigured a provider. Kept so the defect
  // detector cannot silently rot.
  it('500 when the engine rejects unexpectedly (push-hub defect), counting one `error` per attempted target', async () => {
    await registerToken(db, 'team-comm', 'u1', 't-ios', 'ios')
    await registerToken(db, 'team-comm', 'u1', 't-and', 'android')
    engine.send.mockRejectedValueOnce(new Error('bad .p8'))
    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(500)
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'apns' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'fcm' })).toBe(1)
  })
```

Then add these four cases at the end of the `describe('POST /v1/send', …)` block:

```ts
  it('a config fault returns tickets for every target, deletes only invalid rows, and never 500s', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'and-live', 'android')
    await registerToken(db, 'team-comm', 'u1', 'and-dead', 'android')
    const rows = await tokensForUsers(db, 'team-comm', ['u1'])
    const ios = rows.find(r => r.token === 'ios-tok')!
    const live = rows.find(r => r.token === 'and-live')!
    const dead = rows.find(r => r.token === 'and-dead')!
    engine.send.mockResolvedValueOnce([
      { ref: ios.id, token: 'ios-tok', provider: 'apns', status: 'config', error: 'ExpiredProviderToken' },
      { ref: live.id, token: 'and-live', provider: 'fcm', status: 'delivered' },
      { ref: dead.id, token: 'and-dead', provider: 'fcm', status: 'invalid', error: 'Unregistered' },
    ])

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data).toHaveLength(3)
    // the sibling batch survives — this is what #11 is about
    expect(data[1]).toEqual({ userId: 'u1', status: 'ok' })
    expect(data[0]).toEqual({ userId: 'u1', status: 'error', error: 'ExpiredProviderToken' })

    // the invalid row is deleted; the config row is STILL PRESENT — the property the old `throw` protected
    const after = (await tokensForUsers(db, 'team-comm', ['u1'])).map(r => r.token).sort()
    expect(after).toEqual(['and-live', 'ios-tok'])

    expect(await readSeries('push_sends_total', { status: 'config', provider: 'apns' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'delivered', provider: 'fcm' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'invalid', provider: 'fcm' })).toBe(1)
    // defect-backstop series untouched on this path: after test/setup.ts's per-test resetMetrics(),
    // a never-incremented labeled series has no entry at all, so readSeries returns undefined
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'apns' })).toBeUndefined()
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'fcm' })).toBeUndefined()
  })

  it('reports exactly one ProviderConfigError per request, not one per target', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-a', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'ios-b', 'ios')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'config', error: 'ExpiredProviderToken' })))

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(2)
    expect(captureException).toHaveBeenCalledTimes(1) // one event for the request, not one per target
    expect(captureException.mock.calls[0][0].name).toBe('ProviderConfigError')
    expect(captureException.mock.calls[0][1]).toMatchObject({ tags: { tenant: 'team-comm' } })
    expect(await readSeries('push_sends_total', { status: 'config', provider: 'apns' })).toBe(2)
  })

  it('reports a PushTransportDefect for backstopped error results and still returns tickets', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    const [ios] = await tokensForUsers(db, 'team-comm', ['u1'])
    engine.send.mockResolvedValueOnce([
      { ref: ios!.id, token: 'ios-tok', provider: 'apns', status: 'error', error: 'transport error: boom' },
    ])

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data[0]).toEqual({ userId: 'u1', status: 'error', error: 'transport error: boom' })
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException.mock.calls[0][0].name).toBe('PushTransportDefect')
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'apns' })).toBe(1)
    // an `error` result is not `invalid` — the token survives
    expect(await tokensForUsers(db, 'team-comm', ['u1'])).toHaveLength(1)
  })

  it('counts an unconfigured provider, keeps its token, and never reports it to Sentry', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    await registerToken(db, 'team-comm', 'u1', 'and-tok', 'android')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => t.provider === 'fcm'
        ? { ref: t.ref, token: t.token, provider: 'fcm', status: 'unconfigured', error: 'provider not configured' }
        : { ref: t.ref, token: t.token, provider: 'apns', status: 'delivered' }))

    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.find((t: any) => t.error === 'provider not configured'))
      .toEqual({ userId: 'u1', status: 'error', error: 'provider not configured' })
    expect(await readSeries('push_sends_total', { status: 'unconfigured', provider: 'fcm' })).toBe(1)
    // routine mid-rollout state: the token survives and holds no GlitchTip issue open
    expect((await tokensForUsers(db, 'team-comm', ['u1'])).map(r => r.token).sort()).toEqual(['and-tok', 'ios-tok'])
    expect(captureException).not.toHaveBeenCalled()
  })

  it('reports nothing to Sentry on a clean send', async () => {
    await registerToken(db, 'team-comm', 'u1', 'ios-tok', 'ios')
    engine.send.mockImplementation(async ({ tokens }: any) =>
      tokens.map((t: any) => ({ ref: t.ref, token: t.token, provider: t.provider, status: 'delivered' })))
    const res = await inject({ to: 'u1', title: 'x', body: 'y' })
    expect(res.statusCode).toBe(200)
    expect(captureException).not.toHaveBeenCalled()
  })
```

The zero-capture assertions are order-independent because `clearMocks: true` (Task 1) resets the module-scoped `captureException` history before every test.

- [x] **Step 2: Run the route tests to verify the new ones fail**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/send.route.test.ts`
Expected: FAIL — `'reports exactly one ProviderConfigError per request…'` and `'reports a PushTransportDefect…'` fail with `expected "spy" to be called 1 times, but got 0 times` (the route does not capture on these paths yet). The `config`-partial and `unconfigured` cases may already pass (the ticket/cleanup/metric code is unchanged by design) — that is expected and fine; they are regression guards for the headline behavior.

- [x] **Step 3: Add the module-scope helpers to `src/routes/send.ts`**

Immediately after the `sendBody` schema (after line 17's closing `})`) and before `export function sendRoutes(...)`, insert:

```ts
// `name` is set explicitly so GlitchTip groups these under the dedicated type, not `Error`.
// Neither is exported: nothing outside this route constructs or catches them.
class ProviderConfigError extends Error { name = 'ProviderConfigError' }
class PushTransportDefect extends Error { name = 'PushTransportDefect' }

const distinct = (values: (string | undefined)[]): string[] =>
  [...new Set(values.map(v => v ?? 'unknown'))].sort()
```

- [x] **Step 4: Add the three report blocks and fix the `catch` log string**

Change the existing `catch`-block log line from:

```ts
      req.log.error({ err }, 'push-hub: engine send failed (tenant misconfig?)')
```

to:

```ts
      req.log.error({ err }, 'push-hub: engine send rejected unexpectedly (push-hub defect) — no tickets returned, cleanup skipped')
```

Everything else in that `catch` (the `recordSend('error', …)` loop, the `Sentry.captureException(err, …)`, the `500`) stays exactly as it is.

Then, immediately after `for (const r of results) recordSend(r.status, r.provider)` and before the `const rowById = …` line, insert:

```ts
    // One event per REQUEST, not per target: a 500-device fan-out on an expired .p8 must
    // produce one GlitchTip issue, not 500. No tokens, refs or user ids in any payload.
    const configFailures = results.filter(r => r.status === 'config')
    if (configFailures.length) {
      const providers = distinct(configFailures.map(r => r.provider))
      const reasons   = distinct(configFailures.map(r => r.error))
      req.log.error(
        { tenant: req.tenant.slug, providers, reasons, failed: configFailures.length, total: results.length },
        'push-hub: provider configuration fault — tenant credentials need fixing',
      )
      Sentry.captureException(
        new ProviderConfigError(`push: ${providers.join('+')} config fault (${reasons.join(', ')})`),
        {
          tags:  { tenant: req.tenant.slug, providers: providers.join('+') },
          extra: { failed: configFailures.length, total: results.length },
        },
      )
    }

    const defects = results.filter(r => r.status === 'error')
    if (defects.length) {
      const providers = distinct(defects.map(r => r.provider))
      const reasons   = distinct(defects.map(r => r.error))
      req.log.error(
        { tenant: req.tenant.slug, providers, reasons, failed: defects.length, total: results.length },
        'push-hub: transport defect — backstop produced error results (push-hub bug, not tenant config)',
      )
      Sentry.captureException(
        new PushTransportDefect(`push: ${providers.join('+')} transport defect (${reasons.join(', ')})`),
        {
          tags:  { tenant: req.tenant.slug, providers: providers.join('+') },
          extra: { failed: defects.length, total: results.length },
        },
      )
    }

    const unconfigured = results.filter(r => r.status === 'unconfigured')
    if (unconfigured.length) {
      req.log.warn(
        {
          tenant: req.tenant.slug,
          providers: distinct(unconfigured.map(r => r.provider)),
          count: unconfigured.length,
          total: results.length,
        },
        'push-hub: send targeted a provider this tenant has not configured',
      )
      // deliberately NO Sentry: a routine mid-rollout state must not hold a GlitchTip issue open forever
    }
```

Do **not** touch `rowById`, `deleteByIds`, the `tickets` map, or the `reply.send`. They already do the right thing for all three new statuses.

- [x] **Step 5: Run the route tests to verify they pass**

Run: `cd /Users/taylor/dev/push-hub && pnpm vitest run test/send.route.test.ts`
Expected: PASS on every case in the file, including the unchanged fan-out, invalid-cleanup, foreign-tenant and empty-user cases.

- [x] **Step 6: Verify the build and the full suite**

Run: `cd /Users/taylor/dev/push-hub && pnpm build && pnpm test`
Expected: build exits 0; every test file PASS, zero failures.

- [x] **Step 7: Commit**

```bash
cd /Users/taylor/dev/push-hub
git add src/routes/send.ts test/send.route.test.ts
git commit -m "feat(send): report config faults and transport defects once per request; keep tickets and cleanup"
```

---

### Task 7: Documentation — the six-status model and the never-rejects invariant

**Files:**
- Modify: `README.md` (after the `/v1/send` paragraph at `:68-71`)
- Modify: `docs/engine-integration.md:23`, `:136-159`, `:209-210`

**Interfaces:**
- Consumes: the final behavior from Tasks 1-6.
- Produces: nothing consumed by code.

- [x] **Step 1: Update `README.md`**

Immediately after the paragraph ending `token lifecycle themselves.` (line 71) and before the `## Configuration` heading, insert a blank line and then:

```markdown
**Read the tickets, not the status code.** `/v1/send` returns `200` whenever push-hub produced
a per-target outcome for the request — including when some targets failed. A provider
configuration fault (expired `.p8`, revoked service account, bad topic) and a provider this
tenant has not configured yet both come back as `200` with `error` tickets carrying the reason
(`"ExpiredProviderToken"`, `"provider not configured"`), **not** a `500`; a fault on one provider
never discards the other provider's delivered results, and dead tokens in the same batch are
still cleaned up. Fix a configuration fault with `PUT /v1/tenant/credentials`. A `5xx` from this
endpoint means push-hub itself failed (database unavailable, an unexpected engine defect) and
carries no tickets at all.
```

- [x] **Step 2: Update the flow diagram legend in `docs/engine-integration.md`**

Replace line 23:

```
      ▲                              │  SendResult[]  (delivered/failed/invalid, echoing ref)
```

with:

```
      ▲                              │  SendResult[]  (delivered/failed/invalid/config/unconfigured/error, echoing ref)
```

Leave lines 19-22 and 24-26 untouched — line 23 sits below the boxes, so its length does not affect the box alignment.

- [x] **Step 3: Update the worked `sendPush` example**

Replace lines 136-151 (from the `// 3. Send …` comment through the closing `}` of `sendPush`) with:

```ts
  // 3. Send — `send()` resolves one SendResult per target and never rejects for a per-token
  //    reason. The catch below is a DEFECT backstop only (a bug in push-hub itself).
  let results
  try {
    results = await push.send({ tokens, notification })
  } catch (err) {
    reportToErrorTracker(err) // push-hub defect — do NOT delete tokens
    return
  }

  // 4. Delete dead tokens by ref.
  const deadIds = results.filter(r => r.status === 'invalid' && r.ref).map(r => r.ref!)
  if (deadIds.length) await db.delete(pushTokens).where(inArray(pushTokens.id, deadIds))

  // 5. Report the loud outcomes. `config` means YOUR credentials are broken — never the token.
  const misconfigured = results.filter(r => r.status === 'config')
  if (misconfigured.length) {
    reportToErrorTracker(
      new Error(`push: ${misconfigured.length}/${results.length} config faults`),
      { reasons: [...new Set(misconfigured.map(r => r.error))] }, // no tokens, no user ids
    )
  }

  const failed = results.filter(r => r.status === 'failed')
  if (failed.length) reportToErrorTracker(new Error(`push: ${failed.length}/${results.length} failed`), { failed })
}
```

- [x] **Step 4: Replace the three rules with five, and add the invariant**

Replace the block from the line `The three rules that make this correct-by-default:` through the fire-and-forget paragraph (the one beginning `If your sends are fire-and-forget`) with:

```markdown
The five rules that make this correct-by-default:
- **`invalid` → delete** (keyed by `ref`, never by re-matching the token string).
- **`failed` → keep + log** (transient or unknown — deleting would be wrong).
- **`config` → report loudly, keep the token, fix the credentials** (expired `.p8`, 401/403, bad topic — nothing is wrong with the token, and no retry helps until a human acts).
- **`unconfigured` → keep the token, register the credentials when ready** (device tokens exist for a provider you hold no credentials for — a routine mid-rollout state, not an incident; don't page on it).
- **`error` → the defect backstop fired: keep the token, report it as a bug** (a transport rejected instead of returning results, so this target's outcome is unknown — a push-hub problem, never a tenant one).

**Invariant:** `send()` resolves **one `SendResult` per input target** and **never rejects for a
per-token reason**. A per-token provider fault — a credential fault included — can never discard a
sibling target's outcome, in the same transport or the other one. The `try/catch` in step 3 is
therefore only ever reached by a defect.

If your sends are fire-and-forget (`sendPush(...).catch(...)`), the `config` reporting in step 5
still runs inside `sendPush` — which is exactly why the reporting lives there and not at the call sites.
```

- [x] **Step 5: Update the `expo-server-sdk` comparison rows**

Replace the `| Send |` comparison row:

```markdown
| Send | `sendPushNotificationsAsync(chunk)` → tickets | `send({ tokens, notification })` → `SendResult[]` |
```

with:

```markdown
| Send | `sendPushNotificationsAsync(chunk)` → tickets | `send({ tokens, notification })` → `SendResult[]` — exactly one per input target, never rejects for a per-token reason |
```

Replace the `| Dead-token signal |` comparison row:

```markdown
| Dead-token signal | ticket/receipt `details.error === 'DeviceNotRegistered'` — often only in **receipts** you poll later | `result.status === 'invalid'` — returned **synchronously** from the same `send()` |
```

with:

```markdown
| Dead-token signal | ticket/receipt `details.error === 'DeviceNotRegistered'` — often only in **receipts** you poll later | `result.status === 'invalid'` — returned **synchronously** from the same `send()`, and never confused with `config`/`unconfigured` (which must never delete a token) |
```

- [x] **Step 6: Verify the docs are consistent and nothing else is stale**

Run: `cd /Users/taylor/dev/push-hub && git grep -n "fail-loud\|delivered/failed/invalid,\|The three rules\|tenant misconfig" -- README.md docs/engine-integration.md src/`
Expected: **no matches** (exit code 1). Every phrase is anchored on deleted text — in particular `delivered/failed/invalid,` (trailing comma included) matches only the OLD three-status legend; the new legend continues `…/invalid/config/…` and must not match. The pathspec names `docs/engine-integration.md` directly so the historical spec/plan files under `docs/superpowers/` (which legitimately quote the old phrases) are never scanned.

Run: `cd /Users/taylor/dev/push-hub && pnpm build && pnpm test`
Expected: build exits 0; every test file PASS, zero failures.

- [x] **Step 7: Commit**

```bash
cd /Users/taylor/dev/push-hub
git add README.md docs/engine-integration.md
git commit -m "docs: describe the six-status send model and the one-result-per-target invariant"
```

---

## Acceptance criteria (from the design / issue #11)

Verify each after Task 7. These are the design's own acceptance list — every one must hold.

- [ ] A config-classified per-token error no longer throws out of `src/engine/apns.ts` / `src/engine/fcm.ts`; it maps to `SendResult { status: 'config' }` via the transports' `onError` mappers. (`git grep -n 'throw e' -- src/engine/ ':!src/engine/concurrency.ts'` returns nothing — the only `throw e` left anywhere in `src/engine/` is `retryTransient`'s legitimate retry-exhaustion rethrow in `concurrency.ts`, which this plan never touches.)
- [ ] `mapWithConcurrency` requires an `onError(item, error) => R` mapper, never rejects when `onError` returns, and maps a throwing item to exactly one in-place result — proven by `test/engine/concurrency.test.ts`.
- [ ] `engine.send()` resolves with exactly one result per input target on every path, including a transport-level rejection — proven by `test/engine/index.test.ts`'s `'resolves exactly one result per input target even when a transport rejects'`.
- [ ] A config fault on one transport leaves the sibling transport's delivered results intact.
- [ ] `/v1/send` returns `200` with a ticket for every attempted target, and runs `deleteByIds` for the `invalid` rows, when some targets fail for config reasons.
- [ ] A `config` result never deletes a token.
- [ ] The `config` fault is loud: `push_sends_total{status="config",provider}` per target, and exactly one Sentry `ProviderConfigError` per affected request.
- [ ] A send to a provider the tenant has not configured is counted `unconfigured`, keeps the token, and produces no Sentry event.
- [ ] `push_sends_total{status="config"}` can only be incremented by classifier-attributed credential faults — never by a missing provider (`unconfigured`) or a transport defect (`error`).
- [ ] `test/send.route.test.ts`'s "500 when the engine throws" case is re-framed to the unexpected-rejection path and still passes; the new partial-results case passes.
- [ ] `README.md` and `docs/engine-integration.md` describe the six-status model and the "never rejects for a per-token reason" invariant.
- [ ] `pnpm build` and `pnpm test` are green.

## Out of scope (do not implement)

Listed here so a task implementer does not "helpfully" add them:

- No change to construction-time validation (`ApnsTransport` / `FcmTransport` constructors still throw on structurally-bad credentials; `TenantRegistry.buildOrThrow` still maps that to `400`).
- No `207 Multi-Status`, no new response envelope, no new ticket field.
- No batch short-circuit / provider circuit-breaker — remaining targets in a batch still make their own doomed request after the first `config` classification. (Follow-up.)
- No retry/queue semantics and no auto-remediation.
- No `retryable` on `config` / `unconfigured` / `error` results.
- `test/engine/classify.test.ts`, `test/app.test.ts`, `test/metrics.test.ts` and every non-send suite stay untouched.
- No commits beyond the seven above, no push, no PR, no GitHub issue.
