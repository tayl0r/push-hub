---
dev-flow:
  slug: gh-11-engine-partial-send-results
  stops: []
---

# Engine: partial send results — a config fault must not discard the batch — Design

**Issue:** [#11](https://github.com/tayl0r/push-hub/issues/11) — Engine: a config-classified per-token error discards the entire batch's results (sibling transport included)
**Date:** 2026-07-23
**Provenance:** surfaced by the adversarial design review for [#10](https://github.com/tayl0r/push-hub/issues/10) (Prometheus metrics) and deliberately deferred out of that PR — #10 made the incident *observable* (`push_sends_total{status="error"}`), this change fixes the *semantics*.
**Baseline:** written against `main` at `715df00` (#10 merged) — engine vendored at `src/engine/`, metrics at `src/metrics.ts`.

## Problem

A single per-token error that classifies as `kind === 'config'` destroys the outcome of an entire `/v1/send`, including every unrelated success. Verified in code:

1. **The transports throw from inside a concurrency worker.** `src/engine/apns.ts:53` and `src/engine/fcm.ts:77` both do `if (c.kind === 'config') throw e` from the callback passed to `mapWithConcurrency`. (`src/engine/fcm.ts:34` is a third throw site: a missing OAuth access token is constructed as `new FcmError({ kind: 'config' }, 'no access token')`.) The config set is small and entirely credential/topic-shaped — `InvalidProviderToken`, `ExpiredProviderToken`, `BadTopic`, `TopicDisallowed`, `MissingTopic` (`src/engine/classify.ts:5-7`) and FCM HTTP `401`/`403` (`src/engine/classify.ts:24`).
2. **`mapWithConcurrency` has no partial-result path.** `src/engine/concurrency.ts:15` assigns `results[idx] = await fn(items[idx]!)` inside a worker loop, and `src/engine/concurrency.ts:19` joins the workers with `Promise.all`. One throwing worker rejects the join, so the `results` array — already holding every completed target's `SendResult` — is dropped on the floor. The *other* workers are **not** cancelled: they keep pulling indices and keep hitting the provider. So the throw does not even save the wasted sends; it only discards their outcomes.
3. **`createPushService` joins both transports with `Promise.all`.** `src/engine/index.ts:18-21`. A rejection from either transport rejects `engine.send`, so a fully healthy FCM batch of 100 delivered pushes is discarded because one APNs token hit an expired `.p8`.
4. **The route can only 500.** `src/routes/send.ts:36-43`: the `catch` counts `recordSend('error', t.provider)` per attempted target, logs, `Sentry.captureException`, and returns `500 { error: 'send failed' }` with **no tickets**. Because the `catch` returns early, `deleteByIds` (`src/routes/send.ts:49`) never runs — invalid-token cleanup is skipped even though real deliveries and real `Unregistered` responses happened in that same batch.

The blast radius is therefore: *one* misconfigured provider on *one* tenant erases the result of every send that touches it, silently keeps dead tokens alive, and gives the caller nothing actionable.

`test/send.route.test.ts:129-137` ("500 when the engine throws, and counts one error per attempted target by provider"), `test/engine/index.test.ts:83-92` ("propagates a transport config error (fail-loud) out of send()" — its own comment says *"other provider's results are discarded"*), `test/engine/apns.test.ts:64-68` and `test/engine/fcm.test.ts:60-66` all currently lock this behavior in.

### What "fail-loud" was actually protecting

The `throw` was not an accident — the comments say `// fail-loud: deploy misconfiguration`, and `docs/engine-integration.md:157` teaches the rule *"thrown error → report, don't touch tokens"*. The intent is right: a broken `.p8` must never be swallowed, and it must never be mistaken for a dead device token (which would delete live tokens). The defect is the **mechanism**: loudness was implemented by destroying the return value, in a batch API where the return value is the only per-target record that exists.

## Goals

- `engine.send()` resolves with **exactly one `SendResult` per input target, always** — a per-token provider fault can never discard a sibling target's outcome, in the same transport or the other one.
- A config fault stays **loud**: distinct from `failed`, reported to Sentry, and separately countable in `push_sends_total`.
- A config fault **never deletes a token** (the property `throw` was protecting), and never blocks cleanup of the genuinely `invalid` tokens in the same batch.
- `/v1/send` returns tickets for every target it attempted, and performs invalid-token cleanup, on every path where the engine produced results.
- No change to the ticket shape or the success-path HTTP contract.

## Non-goals

- **No change to construction-time validation.** `ApnsTransport`/`FcmTransport` constructors still `throw` on structurally-bad credentials (`src/engine/apns.ts:13-19`, `src/engine/fcm.ts:20-22`); `TenantRegistry.buildOrThrow` (`src/registry.ts:96-103`) converts that to `InvalidCreds` → `400` on `POST /v1/tenants` / `PUT /v1/tenant/credentials`, and `registry.load()` fails the boot. That fail-fast seam is correct and untouched. This change is only about **per-send, per-target** faults.
- **No 207 / new status code, no new response envelope, no ticket field.** (See *HTTP / API contract*.)
- **No batch short-circuit / provider circuit-breaker.** Once one APNs target reports `ExpiredProviderToken`, every remaining target in that batch still makes its own doomed request. That is exactly today's behavior (see Problem #2) so it is not a regression, and batch sizes here are "the devices of the addressed users". Filed as a follow-up.
- **No retry/queue semantics.** Config faults remain non-retryable and are not re-enqueued anywhere; push-hub has no queue.
- **No auto-remediation.** push-hub does not disable a tenant's provider or self-heal credentials; the fix path stays the tenant-authed `PUT /v1/tenant/credentials` (`src/routes/tenants.ts:42`).

## Approach (chosen): first-class per-target outcomes — `'config'` and `'unconfigured'` statuses, defect backstop as `'error'`

Make "provider configuration fault" a **first-class per-target outcome** in the same union the rest of the system already branches on, and delete the throw sites. Loudness moves from the control flow to the observability plane, where it belongs — and the taxonomy is split finely enough that the loud signal stays loud: a *broken configured credential* (`config`) is an incident, an *absent provider* (`unconfigured`) is a routine rollout state, and a *push-hub bug* (`error`) is neither.

The one-result-per-target invariant is then made structural rather than conventional: it is enforced by `mapWithConcurrency` itself (§3) and backstopped by the orchestrator (§4).

### 1. `src/engine/types.ts` — widen the union

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

`SendResult` is otherwise unchanged. `retryable` stays **absent** on `config`, `unconfigured` and `error` results, matching `invalid` (all four mean "retrying is pointless"); only `failed` sets it (`src/engine/apns.ts:55`, `src/engine/fcm.ts:79`). Nothing in `src/` reads `retryable` today (verified — the only occurrences are the two write sites, the type declaration, and test assertions), so leaving it absent is consistent and costs nothing.

**Who may emit what.** Transports can emit only `delivered | failed | invalid | config`; `unconfigured` is synthesized solely by the orchestrator's missing-transport branch and `error` solely by its defect backstop (§4). That split is the whole basis for the alerting rules below — it is an invariant the `test/engine/index.test.ts` cases pin directly.

Widening the union is **not** a compile break, even at three new members: every consumer branches on equality, never on an exhaustive `switch`. The complete consumer set (verified by grepping `.status` across `src/`) is three sites, all in `src/routes/send.ts`:

- `:45` — `recordSend(r.status, r.provider)`; `recordSend` takes `status: string` (`src/metrics.ts:125`), so all three new members are counted with no code change.
- `:49` — `r.status === 'invalid'`; none of the three is `'invalid'`, so no new member can ever delete a token.
- `:53-54` — `r.status === 'delivered' ? 'ok' : 'error'` and `error: r.error ?? r.status`; each new member yields an `error` ticket carrying the engine's reason string.

Everything else in `src/engine/` only *writes* `status`. The new equality comparisons added in §5 (`=== 'config'`, `=== 'error'`, `=== 'unconfigured'`) typecheck precisely *because* the members are in the union — a typo there is a compile error, which is the point of using the union rather than a parallel flag. This is verified again below in *HTTP / API contract*.

### 2. `src/engine/apns.ts` / `src/engine/fcm.ts` — error mapping moves to the mapper's `onError` seam

Each transport's per-target `try/catch` disappears. The callback keeps only the happy path; the existing `catch` body moves verbatim into an `onError` mapper (§3), with the `throw e` replaced by a `config` return. APNs:

```ts
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
  (target, e): SendResult => {
    const c = e instanceof ApnsError ? classifyApns(e.reason) : { kind: 'failed' as const }
    const reason = e instanceof ApnsError ? e.reason : e instanceof Error ? e.message : String(e)
    if (c.kind === 'config') return { ref: target.ref, token: target.token, provider: 'apns', status: 'config', error: reason }
    if (c.kind === 'invalid') return { ref: target.ref, token: target.token, provider: 'apns', status: 'invalid', error: reason }
    return { ref: target.ref, token: target.token, provider: 'apns', status: 'failed', retryable: c.kind === 'transient', error: reason }
  },
)
```

The per-target `reasonOf` closure (`src/engine/apns.ts:43`) moves with the code it served and is inlined above; `R` is pinned to `SendResult` by `send()`'s declared return type, and the explicit annotation on `onError` just makes that local and obvious.

FCM mirrors this exactly, keeping its `attempt` closure as-is inside the happy-path callback (`src/engine/fcm.ts:53-70`) and moving the `catch` body (`:74-80`) into `onError` — `const c = e instanceof FcmError ? e.classification : { kind: 'failed' as const }`, `const reason = e instanceof Error ? e.message : String(e)`, `provider: 'fcm'`.

`fcm.ts:34`'s `throw new FcmError({ kind: 'config' }, 'no access token')` stays a throw — it is raised inside `attempt`, so it now surfaces in `onError`, whose `FcmError` branch classifies it `config` for that one target instead of letting it escape. No edit needed there; a test pins it.

`retryTransient` is unaffected: `config` is not `transient`, so its predicate (`src/engine/apns.ts:47`, `src/engine/fcm.ts:72`) is already false and a config fault costs exactly one provider round-trip per target, as today. **No retry amplification.**

After this, a per-target throw — classified provider error, network failure, or a future bug anywhere in the callback — is mapped to exactly one `SendResult` for that target by `mapWithConcurrency` itself. There is no `try` for an editor to accidentally place code outside of; the discipline is the function signature.

### 3. `src/engine/concurrency.ts` — enforce one result per item at the shared boundary

Both transports need the same property — "no per-item throw may discard the batch" — so it belongs in the mapper's contract, not in hand-maintained `try/catch` discipline duplicated per transport. `mapWithConcurrency` gains a **required** fourth argument:

```ts
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

Everything else in the file is unchanged — same worker-pool shape, same index bookkeeping, same clamp, same `Promise.all` join, and `retryTransient` is untouched.

**Why `onError` is required, not optional.** An optional callback would let a future third transport call the mapper without answering the question that matters — *what result does a thrown item produce?* — and silently reintroduce the bug this issue is about. Making it required turns that question into a compile error at the call site. The consequences are exactly the ones we want: a throwing item costs exactly its own slot, its completed siblings keep their real results, and the join always awaits every worker, so no send is left running orphaned behind an early return.

**Residual reject window, stated honestly:** `mapWithConcurrency` can still reject if `onError` *itself* throws — i.e. if the classification code is broken. That is a genuine push-hub defect and is what the §4 backstop exists to catch.

**Why this is a defensible contract change now.** `mapWithConcurrency` has exactly two production callers — the two transports — plus one unit test, and it has been repo-private since the #9 engine consolidation (commit `73ac6c3`) vendored the engine into `src/engine/`; it is not re-exported from `src/engine/index.ts`, which exports only `./types.js`. So it is not a published utility, its blast radius is three files, and 100% of its caller family needs the same total-mapping property. (The earlier framing — "rewrites a generic, well-tested utility's contract for one caller's benefit" — is stale on all three counts.)

### 4. `src/engine/index.ts` — make the invariant structural

With §3 in place a transport cannot reject from a per-target fault at all, but the orchestrator still should not depend on that. The backstop's reachable surface is now a defect outside the per-target map — or `onError` itself throwing. Wrap each transport call so the one-result-per-target invariant holds even then:

```ts
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

async send({ tokens, notification }: SendRequest): Promise<SendResult[]> {
  const [a, f] = await Promise.all([
    runTransport(apns, tokens.filter(t => t.provider === 'apns'), notification),
    runTransport(fcm,  tokens.filter(t => t.provider === 'fcm'),  notification),
  ])
  return [...a, ...f]
}
```

`PushNotification` joins the existing type-only import at `src/engine/index.ts:3`; `notConfigured` (`:11-12`) is replaced by `synthesized`.

`Promise.all` is retained deliberately: with `runTransport` absorbing rejections, neither branch can reject, so `all` and `allSettled` are now equivalent and `all` keeps the typed tuple destructure. The empty-target case needs no guard — `mapWithConcurrency` already returns `[]` for an empty input (the `Math.max(1, …)` clamp at `src/engine/concurrency.ts:18`, unchanged by §3, gives one worker whose `while (next < items.length)` loop never runs when `items.length === 0`).

Two deliberate consequences:

- **`notConfigured` is reclassified `failed` → `unconfigured`, not `config`.** `src/engine/index.ts:11-12` currently returns `status: 'failed', error: 'provider not configured'` when a tenant has no credentials for a target's provider. Folding it into `failed` blurred it with a transient FCM 503; folding it into `config` would be worse. `POST /v1/tokens` (`src/routes/tokens.ts:11-17`) accepts a token for any platform with no check against the tenant's provider set, and `buildOrThrow` requires only **one** provider (`src/registry.ts:97`) — so "tokens exist for a provider with no creds" is the *designed norm* during an incremental rollout, not an edge case. A status whose contract is "expected 0, nonzero = fix now" cannot carry a state that is legitimately nonzero for weeks. `unconfigured` keeps it distinct from `failed` on every plane — tickets, metric series, logs — without poisoning the `config` alert. `test/engine/index.test.ts:57` is updated accordingly.
- **The backstop labels a defect `error`, reusing the metric identity #10 already defined for exactly this** — "a batch-level throw destroyed the outcome, counted per attempted target". Zero new series, and it preserves the binary this design is built on: `config` = a tenant rotates credentials, `error` = a push-hub bug. The reason string stays prefixed `transport error:`, which is what reaches the log line, the Sentry message, and the ticket.

### 5. `src/routes/send.ts` — decide the response, keep cleanup

The ticket-building and cleanup code (`:45`, `:49`, `:51-56`) needs **no change** — none of `config` / `unconfigured` / `error` is `'delivered'`, so each yields an `error` ticket; `error: r.error ?? r.status` already carries the provider reason (e.g. `ExpiredProviderToken`); and none is `'invalid'`, so the token is never deleted. Cleanup of the genuinely invalid rows in the same batch now runs, which is the headline fix.

Two error classes and one dedup helper go at **module scope**, next to `sendBody` — house style for module-level error classes in this repo (`InvalidCreds`/`SlugTaken` at `src/registry.ts:28-29`, `FcmError` at `src/engine/fcm.ts:9`). Neither class is exported: nothing outside this route constructs or catches them.

```ts
// `name` is set explicitly so GlitchTip groups these under the dedicated type, not `Error`.
class ProviderConfigError extends Error { name = 'ProviderConfigError' }
class PushTransportDefect extends Error { name = 'PushTransportDefect' }

const distinct = (values: (string | undefined)[]): string[] =>
  [...new Set(values.map(v => v ?? 'unknown'))].sort()
```

The in-handler addition is three filters, between the `recordSend` loop (`:45`) and `deleteByIds` (`:49`):

```ts
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

**One event per request**, not per target, for *both* capture types — a 500-device fan-out on an expired `.p8` produces one Sentry event, not 500, and the same holds for the defect backstop. Neither log line nor either Sentry payload carries device tokens or user ids, consistent with the existing "never ship secrets to GlitchTip" stance (`src/index.ts:14-16`).

The existing `try/catch` around `engine.send` (`src/routes/send.ts:36-43`) stays structurally as-is, including its `recordSend('error', …)` accounting, with one text fix: its log line said `(tenant misconfig?)`, a diagnosis this design now rules out for this path — after #11 a rejection here means push-hub itself is broken. `src/routes/send.ts:40` becomes:

```ts
req.log.error({ err }, 'push-hub: engine send rejected unexpectedly (push-hub defect) — no tickets returned, cleanup skipped')
```

matching the `status="error"` row of the Observability table. The path is now unreachable in normal operation, which is the point: a nonzero `push_sends_total{status="error"}` means *push-hub itself* is broken, a genuinely alert-worthy and previously-unavailable signal.

## Rejected alternatives

### A. `Promise.allSettled` at the orchestrator only, transports keep throwing

Change `src/engine/index.ts:18` to `Promise.allSettled` and synthesize error results for a rejected transport's targets; leave `apns.ts:53` / `fcm.ts:77` throwing.

**Rejected.** It fixes only half of the issue. The *sibling* transport is rescued, but every completed result inside the throwing transport's own batch is still destroyed by `mapWithConcurrency` (Problem #2) — an APNs batch of 500 where target #499 hits `ExpiredProviderToken` still loses 498 real deliveries and 12 real `Unregistered` cleanups. It also leaves `PushService.send` typed as something that can reject for a per-token reason, so every future caller must keep a defensive `catch` that guesses at target attribution. Half the blast radius for nearly the same diff.

**Sub-variant (settled tuples), still rejected — but its core insight moved into the chosen design:** returning `PromiseSettledResult<R>[]` from `mapWithConcurrency` would preserve a throwing transport's partials, but it defers error→result mapping to after the join, makes both transports bookkeep tuple unwrapping, and a bug in that unwrapping still rejects the whole batch. The shared mapper *is* the right owner of the "no throw discards the batch" property — its only two callers both need it — so the chosen design implements it as a required in-place `onError` mapper (§3) instead of a contract that hands the problem back to every caller.

### B. Keep `status: 'failed'`, add a `configError?: true` flag to `SendResult`

**Rejected.** `status` is the engine's single decision axis, and the whole documented contract is taught that way — *"invalid → delete, failed → keep + log"* (`docs/engine-integration.md:154-157`). A parallel boolean means every consumer must remember to check two fields, and forgetting silently degrades a credential outage into "some transient failures". It is also invisible where it matters most: `push_sends_total` is labeled by `status` (`src/metrics.ts:41-46`), so a flag folds config faults into `failed` and the whole alerting goal is lost — and it could never express the three-way `config` / `unconfigured` / `error` split this design depends on without three more booleans. A union member is exhaustiveness-checkable by tsc at any future `switch`; a boolean is not.

### C. Keep throwing, attach partial results to the error (`err.partialResults`)

**Rejected.** Smuggling the payload on an exception is untyped in practice and easy to drop, and it does not even work here: `Promise.all` surfaces only the **first** rejection, so if both transports hit config faults the second transport's partials are lost regardless. It also pushes an undocumented convention onto every engine consumer, including the worked example at `docs/engine-integration.md:136-151`.

### D. `207 Multi-Status` (or a mixed status-code policy)

**Rejected** — see the next section for the full argument.

## HTTP / API contract

### The rule

> `POST /v1/send` returns **`200`** whenever push-hub produced a per-target outcome for the request. Per-target success or failure — including a provider configuration fault — lives in the tickets. `5xx` is reserved for push-hub's own failures (DB unavailable, an unexpected engine rejection, an unhandled bug).

Body shape is **unchanged**: `{ "data": [ { userId, status: "ok" | "error", error? } ] }`, one ticket per attempted device, exactly as `README.md:58-66` already documents. No new field, no new envelope.

### What actually changes for a caller

| Scenario | Today | After |
|---|---|---|
| All delivered | `200`, `ok` tickets | **unchanged** |
| Mixed delivered / invalid / failed | `200`, mixed tickets, dead tokens deleted | **unchanged** |
| Expired `.p8` on one APNs token, 100 FCM targets healthy | `500 { error: "send failed" }`, **no tickets**, no cleanup | `200`, 100 `ok` tickets + `error` tickets carrying `ExpiredProviderToken`, counted `config`, cleanup runs |
| A transport rejects for a non-per-target reason (push-hub defect) | `500 { error: "send failed" }`, **no tickets**, no cleanup | `200`, `error` tickets carrying `transport error: …`, counted `error`, cleanup runs |
| Tenant has no FCM credentials, sends to an Android device | `200`, `error` ticket `provider not configured` | **unchanged shape**; now counted as `unconfigured` (own metric series, `warn` log) — deliberately **not** reported to Sentry |
| `engine.send` itself rejects (push-hub bug outside the transports) | `500 { error: "send failed" }` | **unchanged** |

Two rows change, and both change the same way: **a `500` disappears and becomes a `200` with error tickets.**

### Is that a breaking change?

No — and it is a contract *narrowing*, not a widening:

1. **No response shape changes.** Every field a client parses today is present, with the same types. The one new value that can appear is a new `error` *string* on a ticket that was already `status: "error"`-shaped; `README.md:58-66` documents `error` as free-form.
2. **`res.ok` never meant "delivered" and still doesn't.** Today a batch where every token is dead returns `200` with all-`error` tickets. Any client inferring delivery from the HTTP status is already wrong; this change removes the cases where the status code disagreed with the tickets, making the contract *more* consistent, not less.
3. **Clients that retry on `5xx` are strictly better off.** A config fault is non-retryable by definition (`classify.ts` puts it in its own kind precisely because no retry helps). Today those clients hammer a misconfigured provider; after this, they stop.
4. **The realistic downside is a client that checks only the status code and ignores the tickets.** That client now sees "success" during a credential outage. Accepted, because loudness is preserved on the planes that exist for it (Sentry/GlitchTip and Prometheus, both already wired — `src/index.ts:10-17`, #10), because such a client is *already* blind to a 100%-dead-token batch, and because push-hub is internal-only with first-party callers (see *Assumptions*).

### Why not `207 Multi-Status`

- `207` is defined by RFC 4918 (WebDAV) with a `multistatus` XML body; its use for JSON batch APIs is a borrowed convention, not a standard, and it buys nothing a ticket array does not already express.
- It **is** a real breaking change for any client written as `if (res.status === 200)`, whereas 200-with-error-tickets is a shape every client already handles.
- The trigger condition is ill-defined. Is an all-`invalid` batch "partial"? An all-`failed` one? Any rule we pick makes today's `200` responses start returning `207` for reasons unrelated to #11 — scope creep with a compatibility cost.
- push-hub's `/v1/send` is deliberately Expo-flavored (`README.md:48`), and the Expo push API's own contract is `200` + per-ticket errors. Matching it keeps one mental model.

If a partial-status signal is ever wanted, it is cleanly additive later (an opt-in header or `?status=multi`), so nothing here forecloses it.

### Why no new ticket field

A ticket could carry a machine-readable `reason: "config"` so a caller can tell "this device is dead" from "your credentials are broken". Deliberately omitted: the caller cannot act differently at request time (all of these are non-retryable for that device), the human who *can* act is the operator, and the operator is served by Sentry + `push_sends_total{status="config"}` with far more context than a ticket field. Adding public API surface that nothing consumes is the wrong default. The provider's own reason string (`ExpiredProviderToken`, `UNAUTHENTICATED`, `provider not configured`, `transport error: …`) is already in the ticket's `error` for anyone who wants it.

**Disclosure note:** those reason strings are provider error codes, not secrets, and the backstop path echoes an exception message. Even in the worst case a tenant sees a fragment of *its own* credential material, over its own API key, on an internal-only network — no cross-tenant or third-party exposure. (This is a different vector from `src/index.ts:14-16`, which suppresses request bodies because the *tenants* route body is plaintext creds.)

## Observability

### Metrics (`push_sends_total`, from #10)

`status` gains the values `config` and `unconfigured` (`error` already exists, from #10). Full label set becomes `delivered | failed | invalid | config | unconfigured | error` × `apns | fcm` = **12 series** — still a fixed, small enum, within #10's cardinality guard (never labeled by tenant, token, or user).

The three non-`delivered`/non-`failed`/non-`invalid` statuses mean three different things, and that separation is the point:

| Label | Meaning after this change | Expected rate |
|---|---|---|
| `status="unconfigured"` | Tenant has device tokens for a provider it holds no credentials for. Tickets returned, token kept. | Nonzero is routine (mid-rollout); dashboard, never an alert |
| `status="config"` | A configured provider's credentials/topic are broken. Per-target outcome known, tickets returned, cleanup ran. | 0; nonzero = a tenant must fix credentials |
| `status="error"` | Push-hub defect — either the transport backstop fired (tickets returned) or `engine.send` rejected outright (500, no tickets, no cleanup). | 0; nonzero = a push-hub **bug** |

Suggested alerts:

- `increase(push_sends_total{status="config"}[15m]) > 0` — a tenant credential outage, with the `provider` label naming which credential set to fix. This rule is now *honest*: after the split it can only be incremented by a classifier-attributed credential fault on a provider the tenant actually configured.
- `increase(push_sends_total{status="error"}[15m]) > 0` — a push-hub bug. `error` is emitted from two sites, the §4 backstop (per result) and the route `catch` (per attempted target); both mean "defect" and both count in the same unit, so one rule covers both.
- **`unconfigured` is deliberately excluded from alerting.** It is legitimately nonzero for as long as a tenant is mid-rollout, so any threshold on it would either be permanently firing or meaningless. It belongs on the dashboard, next to `delivered`.

The existing #10 dashboard needs no change; `sum(push_sends_total)` stays in one unit (targets attempted) on every path. `recordSend(r.status, r.provider)` (`src/routes/send.ts:45`) already emits the new labels with no code change — `recordSend` takes `status: string` (`src/metrics.ts:125`).

### Sentry / GlitchTip

- **One `captureException` per request** that contained ≥1 `config` result, with a dedicated `ProviderConfigError` type. Message is `push: <providers> config fault (<distinct reasons>)` — stable per (provider set × reason set), so GlitchTip groups an ongoing outage into **one issue** rather than one per request, and an expired-`.p8` outage stays a separate issue from a bad-topic misconfiguration.
- **One `captureException` per request** that contained ≥1 `error` result, with a dedicated `PushTransportDefect` type and message `push: <providers> transport defect (<distinct reasons>)`. Same one-per-request, same tag/extra discipline. A separate type because the triage owner is different: this one is a push-hub bug, not a tenant's credentials.
- **`unconfigured` results produce no Sentry event at all.** GlitchTip issues must be closable, and this state can legitimately persist for weeks; an issue that cannot be resolved trains operators to ignore the project. It is visible in the ticket, the metric series, and a tenant-tagged `warn` log instead.
- Tags: `tenant` (as the existing `catch` already does, `src/routes/send.ts:41`) and `providers`. `providers` has three possible values (`apns`, `fcm`, `apns+fcm`) — low cardinality.
- Extra: `failed` / `total` counts. **Never** tokens, refs, or user ids.
- The pre-existing `catch`-block `captureException` is untouched and keeps covering the unexpected-rejection path.

### Logs

- `req.log.error` with structured fields (`tenant`, `providers`, `reasons`, `failed`, `total`) for both the `config` and the `error` batches — greppable in Loki, no secrets.
- `req.log.warn` with (`tenant`, `providers`, `count`, `total`) for an `unconfigured` batch. `warn`, not `error`: it is a state a tenant may be in on purpose, but a tenant that *meant* to configure the provider needs to be able to find it.
- The route `catch`'s existing `req.log.error` keeps its `err` field and gains the corrected "push-hub defect" wording (§5).

### Trade-off: latency during a config outage

Today the `Promise.all` rejection returns the route early, while the remaining sends keep running orphaned in the background (Problem #2). After this change the route waits for the full batch. So `/v1/send` p99 during a credential outage rises from "time to first config error" to "time to complete the batch". This is bounded and small — a batch is the devices of the addressed users, at concurrency 50 (APNs) / 10 (FCM), with **no retries** on the config path — and it buys back the results. Recorded as an accepted cost; the batch short-circuit that would eliminate it is a listed follow-up.

## Documentation updates (in this PR)

- **`README.md`** (`/v1/send` section, ~lines 58-71): note that a provider configuration fault (expired `.p8`, revoked service account) and a not-yet-configured provider both return `200` with `error` tickets carrying the reason — not a `500` — and that the fix for the former is `PUT /v1/tenant/credentials`. Callers must read tickets, not the status code, to know what was delivered.
- **`docs/engine-integration.md`**: the four places that teach the three-status model and the throw contract —
  - `:23-25` diagram legend (`delivered/failed/invalid` → the six-member union `delivered/failed/invalid/config/unconfigured/error`);
  - `:136-151` the worked `sendPush` example, whose step-3 `try/catch` around `push.send` becomes a `config`-result filter (the `catch` stays, demoted to a defect backstop);
  - `:154-159` the three rules → **five** rules, and the removal of *"thrown error → report, don't touch tokens"* as the primary path:
    - `invalid` → delete (keyed by `ref`),
    - `failed` → keep + log,
    - `config` → report loudly, keep the token, fix the credentials,
    - `unconfigured` → keep the token, register the credentials when ready; not an incident,
    - `error` → the defect backstop fired: keep the token, report it as a **bug**;
  - `:209-210` the `expo-server-sdk` comparison table rows that describe the `SendResult[]` return and the dead-token signal.
  Add the new invariant explicitly: **`send()` resolves one `SendResult` per input target and never rejects for a per-token reason.**

## Testing (TDD)

Test infrastructure changes in exactly one line: `vitest.config.ts` gains `clearMocks: true` (rationale in the Sentry bullet below — every mock's call history resets before each test, so zero-call assertions are order-independent by default). Everything else is unchanged: `pnpm test` (`vitest run`), `fileParallelism: false`, `test/setup.ts` zeroes metric values before every test, and `test/helpers/metrics.ts`'s `readSeries` reads absolute series values with exact per-label matching (no wildcards).

### `test/engine/apns.test.ts`

- **Rewrite** `:64-68` "InvalidProviderToken → throws (fail-loud)" → **"InvalidProviderToken → a `config` result, not a throw"**: asserts `{ status: 'config', error: 'InvalidProviderToken' }` and that `send()` resolves.
- **Add** "a config fault on one target does not discard its siblings": a 3-target batch where one target hits `ExpiredProviderToken` and the others resolve → 3 results, in input order, `delivered / config / delivered`, refs echoed. Drive the `apns2` mock with a `mockImplementation` keyed on the notification's `deviceToken`, not a `mockRejectedValueOnce` call-order chain — targets are dispatched concurrently, so the test must not depend on worker scheduling.

### `test/engine/fcm.test.ts`

- **Rewrite** `:60-66` "401 UNAUTHENTICATED → throws (fail-loud config error)" → asserts a `config` result. **Add** the `403 PERMISSION_DENIED` case with **no** `FcmError` detail in `details[]` — a 403 carrying `errorCode: 'SENDER_ID_MISMATCH'` is classified `invalid`, not `config` (`src/engine/classify.ts:22` is checked before the status-code rule at `:24`), so the fixture must omit it to exercise the config branch.
- **Add** "no access token → `config` result" — the `getAccessToken` mock resolves `{ token: undefined }`, pinning `src/engine/fcm.ts:34`, whose throw must now be routed through `onError`'s `FcmError` branch rather than escaping.
- **Add** the sibling-preservation case, mirroring the APNs one, with the `fetch` mock keyed on the request body's `message.token` rather than on call order.

### `test/engine/concurrency.test.ts`

No longer "unchanged": `mapWithConcurrency` gains a required fourth argument (§3), so this file both adapts and grows a case for the new contract.

- **Update** `:5-15` "preserves order and caps in-flight count" for the fourth argument. Its `fn` never throws, so pass a trivial mapper — `() => 0 /* unreachable: fn never throws */` — and leave the `[2, 4, 6, 8, 10]` / `maxInFlight <= 2` assertions exactly as they are.
- **Add** "a throwing item is mapped by `onError` in place, siblings keep their results, and the promise resolves": items `[1, 2, 3]`, limit `2`, `fn` returning `n * 2` but throwing on `2`, `onError: (n: number) => -n`. Expect `[2, -2, 6]` — the throwing item's slot holds its mapped value, its siblings hold their real results, order is preserved, and the call resolves rather than rejecting. This is the unit-level proof of the property §2 and §4 both depend on.

### `test/engine/index.test.ts`

- **Rewrite** `:83-92` "propagates a transport config error (fail-loud) out of send()" → **"a transport-level rejection never discards the sibling transport's results"**: with the `*-config-boom` mock rejecting APNs, assert the FCM targets still come back `delivered`, the APNs targets come back `status: 'error'` with a `transport error:`-prefixed `error`, and `send()` resolves. (Its current inline comment *"other provider's results are discarded"* is the exact behavior being deleted.) Note the status: a transport that rejects is a **defect**, not a tenant config fault.
- **Update** `:51-58` — the case is renamed off "failed results" and `notConfigured` now asserts `{ status: 'unconfigured', error: 'provider not configured', ref: 'r2' }`.
- **Add** the invariant test: for a mixed 4-target batch across both providers and a mix of outcomes, `results.length === tokens.length` and every input `ref` appears on exactly one result. This is the structural guarantee the whole change exists to provide.
- Together, the two rewritten cases also pin the emission invariant from §1: `unconfigured` comes only from the missing-transport branch and `error` only from the backstop — a transport's own results are never either.
- The `beforeEach` at `:36` (`apnsClose.mockClear(); fcmClose.mockClear()`) is dropped — `clearMocks: true` covers it, and this file is rewritten in this PR anyway.

### `test/send.route.test.ts`

- **Keep and re-frame** `:129-137`. The mock (`engine.send.mockRejectedValueOnce(...)`) and the assertions (`500`, one `push_sends_total{status="error"}` per attempted target by provider) all stay valid — but the case now covers only the *unexpected engine rejection* path, so it is renamed from **"500 when the engine throws, and counts one error per attempted target by provider"** to **"500 when the engine rejects unexpectedly (push-hub defect), counting one `error` per attempted target"**, and its comment stops attributing the path to tenant misconfiguration. Preserving this test is deliberate: the defect backstop must not silently rot.
- **Add** the case that #11 is actually about — *"a config fault returns tickets for every target, deletes only invalid rows, and never 500s"*: register 1 iOS + 2 Android tokens; `engine.send` resolves with the APNs target `status: 'config', error: 'ExpiredProviderToken'`, one FCM target `delivered`, one FCM target `invalid`. Assert:
  - `200`, `data.length === 3`;
  - the delivered target's ticket is `{ userId, status: 'ok' }` — the sibling batch survives;
  - the config target's ticket is `{ userId, status: 'error', error: 'ExpiredProviderToken' }`;
  - the `invalid` row is deleted and the `config` row is **still present** (`tokensForUsers` after the call) — the property the old `throw` was protecting, now proven directly;
  - the metric series, as literal `readSeries` calls mirroring the existing 500-path test at `test/send.route.test.ts:135-136`:

    ```ts
    expect(await readSeries('push_sends_total', { status: 'config', provider: 'apns' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'delivered', provider: 'fcm' })).toBe(1)
    expect(await readSeries('push_sends_total', { status: 'invalid', provider: 'fcm' })).toBe(1)
    // defect-backstop series untouched on this path: after test/setup.ts's per-test resetMetrics(),
    // a never-incremented labeled series has no entry at all, so readSeries returns undefined
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'apns' })).toBeUndefined()
    expect(await readSeries('push_sends_total', { status: 'error', provider: 'fcm' })).toBeUndefined()
    ```

    `readSeries(fullName, labels)` is `async` and matches every supplied label *exactly* (`Object.entries(labels).every(...)`) — there is no wildcard, so `{status="error",provider="*"}` cannot be expressed. `apns` and `fcm` are the complete `provider` label space, so the two explicit `toBeUndefined()` checks cover exactly what the wildcard meant. The `toBeUndefined()` idiom (rather than `toBe(0)`) is the one already used at `test/app.test.ts:72` for a never-incremented series.
- **Add** the unconfigured-provider case: a tenant with APNs-only credentials sending to 1 iOS + 1 Android token → `200`; the Android ticket is `{ userId, status: 'error', error: 'provider not configured' }`; `push_sends_total{status="unconfigured",provider="fcm"} == 1`; the Android token is **not** deleted; and **zero** Sentry captures.
- **Add** Sentry assertions. `send.route.test.ts` does not currently mock `@sentry/node` (captures are inert no-ops without `Sentry.init`). Mock it with a hoisted handle so the assertions can reach the spy:

  ```ts
  const captureException = vi.hoisted(() => vi.fn())
  vi.mock('@sentry/node', () => ({ captureException }))
  ```

  Assert exactly **one** capture for a multi-target config batch (not one per target), typed and tagged:

  ```ts
  expect(captureException).toHaveBeenCalledTimes(1)
  expect(captureException.mock.calls[0][0].name).toBe('ProviderConfigError')
  expect(captureException.mock.calls[0][1]).toMatchObject({ tags: { tenant: 'team-comm' } })
  ```

  (`team-comm` is the slug the file's tenant fixture uses, `test/send.route.test.ts:16`.) Assert **zero** captures on a clean send, and **zero** on an unconfigured-only batch.

  **Why `clearMocks` is needed for this.** The mock is module-scoped, so without a per-test reset its call history accumulates across `it()`s and the zero-capture assertions become order-dependent — and nothing resets it today: `vitest.config.ts` sets none of `clearMocks`/`mockReset`/`restoreMocks`, `test/setup.ts` resets only metrics, and this file's `beforeEach` (`:24`) resets only `engine.send`. Fix it at the config seam rather than adding a fifth hand-rolled per-file reset: add `clearMocks: true` to `vitest.config.ts`, repo-wide. Verified safe: every call-history assertion in the suite reads calls made inside its own `it()` — no test depends on history recorded by an earlier one. Two now-redundant hooks are dropped, `test/engine/fcm.test.ts:19` and `test/engine/index.test.ts:36` (both `mockClear()`-only, and both files are rewritten in this PR anyway); `test/registry.test.ts:30` and `test/tenants.route.test.ts:33` are left alone. Every `mockReset()` hook **stays** (`test/send.route.test.ts:24`, `test/app.test.ts:19`, `test/engine/apns.test.ts:43`) — `clearMocks` clears call history only, while `mockReset` is what discards a persistent `mockImplementation`/`mockRejectedValue` set by a previous case.

### Unchanged

`test/engine/classify.test.ts` (classification rules are untouched), `test/app.test.ts`, `test/metrics.test.ts`, and every non-send suite. (`clearMocks: true` applies repo-wide, but changes no assertion in these files — see the verification note above.)

## Assumptions (defensible defaults, recorded)

1. **All `/v1/send` callers are first-party.** push-hub is internal-only by design — no `web` network, no Traefik route, reachable only from `apps_internal` (`README.md:129-131`, #10 design § Non-goals). Turning a `500` into a `200`-with-error-tickets is therefore a coordinated change across known callers, not an unversioned break for an unknown third party. *If a third-party caller existed, the correct alternative would be a versioned endpoint or an opt-in header, not this in-place change.*
2. **Loudness belongs on the observability plane, not in the HTTP status code.** GlitchTip and Prometheus are both already wired and are where an operator learns about incidents; the status code is a per-request transport signal for a caller who cannot fix credentials anyway.
3. **One Sentry event per request is the right signal/noise point** — per-target would emit hundreds per fan-out; per-tenant-per-hour would need state push-hub does not have.
4. **`provider not configured` gets its own status, `unconfigured`, deliberately quieter than `config`.** It is a routine state under incremental rollout — token registration is platform-unconstrained (`src/routes/tokens.ts:11-17`) and one provider suffices at registration (`src/registry.ts:97`) — so it must not fire the `config` alert or hold a GlitchTip issue open. But it stays distinct from `failed` (it is neither transient nor retryable) and separately countable. A tenant that *meant* to configure the provider still sees it in the tickets, in the `push_sends_total{status="unconfigured"}` series, and in the tenant-tagged `warn` log.
5. **The route's `catch` + `status="error"` accounting is kept on purpose** as a defect detector, not left behind as dead code. Its log text is corrected to say "push-hub defect": after #11 the old `(tenant misconfig?)` guess is precisely the diagnosis this design rules out for that path.
6. **`config`, `unconfigured` and `error` results all carry no `retryable` field** (absent = not retryable), matching `invalid`. No consumer reads `retryable` today.

## Rollout & rollback

- **No migration.** No schema change, no new env var, no compose/Dockerfile change, no new dependency. Code + tests + docs only.
- **Deploy path** is the standard one: squash-merge to `main` → CI builds `:dev` and deploys `push-hub-dev` → verify → promote with `git push origin main:prod`.
- **Verification on dev** (the behavior is only observable with broken creds, so induce it): register a throwaway tenant with a well-formed-but-wrong FCM service account (registration validates shape only — `README.md:106-108`) plus one valid provider, register one token per platform, `POST /v1/send`, and confirm `200` with mixed tickets, `push_sends_total{status="config"}` incremented on `:9464/metrics`, and exactly one GlitchTip issue. Then send via a second throwaway tenant that has *one provider absent altogether*, and confirm `push_sends_total{status="unconfigured"}` increments, the token survives, and **no** new GlitchTip issue appears.
- **Rollback is a plain image revert.** Nothing is persisted differently and no external contract is versioned, so reverting restores the old `500` behavior with no data to unwind. The one thing a revert does *not* unwind: tokens that were correctly deleted during a config incident stay deleted — which is the desired outcome anyway (they were `invalid`, independently of the config fault).
- **Operator note for the deploy window:** any dashboard or runbook that keys "push-hub credential outage" off `http_requests_total{route="/v1/send",status="500"}` must move to `push_sends_total{status="config"}`. As of #10 no such alert exists yet, so this is a note for the runbook, not a migration task.

## Follow-ups (out of scope)

- **Provider circuit-breaker / batch short-circuit.** Once one target in a batch reports a `config` classification for a provider, mark that provider's remaining targets `config` without a network call. Removes the wasted round-trips and the latency cost noted above; needs care around shared mutable state inside `mapWithConcurrency`'s callback. Worth doing only if batch sizes grow beyond one user's device set.
- **Tenant-facing credential health.** A `GET /v1/tenant/health` (or a `credsLastFailedAt` column) so a tenant can see "your APNs credentials have been failing since 14:02" without reading push-hub's Sentry. Larger design; genuinely separate.

## Acceptance criteria (from #11)

- [ ] A config-classified per-token error no longer throws out of `src/engine/apns.ts` / `src/engine/fcm.ts`; it maps to `SendResult { status: 'config' }` via the transports' `onError` mappers.
- [ ] `mapWithConcurrency` requires an `onError(item, error) => R` mapper, never rejects when `onError` returns, and maps a throwing item to exactly one in-place result — proven by a concurrency unit test.
- [ ] `engine.send()` resolves with exactly one result per input target on every path, including a transport-level rejection — proven by an invariant test.
- [ ] A config fault on one transport leaves the sibling transport's delivered results intact.
- [ ] `/v1/send` returns `200` with a ticket for every attempted target, and runs `deleteByIds` for the `invalid` rows, when some targets fail for config reasons.
- [ ] A `config` result never deletes a token.
- [ ] The `config` fault is loud: `push_sends_total{status="config",provider}` per target, and exactly one Sentry `ProviderConfigError` per affected request.
- [ ] A send to a provider the tenant has not configured is counted `unconfigured`, keeps the token, and produces no Sentry event.
- [ ] `push_sends_total{status="config"}` can only be incremented by classifier-attributed credential faults — never by a missing provider or a transport defect.
- [ ] `test/send.route.test.ts`'s "500 when the engine throws" case is re-framed to the unexpected-rejection path and still passes; the new partial-results case passes.
- [ ] `README.md` and `docs/engine-integration.md` describe the six-status model and the "never rejects for a per-token reason" invariant.
- [ ] `pnpm build` and `pnpm test` are green.
