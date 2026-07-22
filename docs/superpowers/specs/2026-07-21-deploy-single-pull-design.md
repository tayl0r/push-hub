---
dev-flow:
  slug: deploy-single-pull
  stops: [post-design, pre-merge]
---

# push-hub — Deploy: single-pull fix (drop the redundant `docker compose pull`)

**Date:** 2026-07-21
**Issue:** tayl0r/push-hub#4
**Status:** **Approach B (minimal inline patch) adopted per user decision, 2026-07-22** — this overrides the adversarial review's Approach-A recommendation, which is retained below as the reasoned analysis of record. See **Decision**.
**Scope:** One CI file (`.github/workflows/deploy.yml`). Remove the redundant second GHCR pull (the issue's stated bug) with a self-contained two-line edit — delete `docker compose pull` and pin `up` to the already-local image with `--pull never`. No new dependency on the shared VPS script; no application-code or VPS-host changes.

## Decision (2026-07-22)

**Adopt Approach B (the minimal, self-contained inline patch), not Approach A.** The adversarial review recommended Approach A (adopt the shared `/opt/apps/deploy.sh`) and its reasoning — preserved in full below — is sound. The user chose Approach B deliberately: keep the fix self-contained and minimal, and **avoid taking a runtime dependency on the `tayl0r/vps`-owned `/opt/apps/deploy.sh`** (the coupling flagged as assumption A2 — push-hub cannot pin that script's version). Accepted tradeoff: this removes only the redundant second pull (the issue's literal bug); pull #1 keeps no retry and the shared `/root/.docker/config.json` login, and push-hub stays a per-app copy of the deploy step rather than converging on the fleet seam. **The adopted change is Approach B's exact diff, in "The change" below.** Approach A's analysis and YAML are kept unchanged as the recorded, declined alternative.

---

## Problem

The deploy step pulls the image explicitly and then pulls it **again** via `docker compose pull`:

```bash
docker pull "$IMAGE"                                        # pull #1 — feeds the migrate below
docker run --rm --network "$DEPLOY_NETWORK" \
  --env-file "$DEPLOY_DIR/.env" "$IMAGE" pnpm db:migrate    # runs the pulled image
cd "$DEPLOY_DIR"
docker compose pull                                        # pull #2 — REDUNDANT, same ref
docker compose up -d
docker image prune -f
```

The image is **already local** from pull #1, so the `docker compose pull` is a pure second registry round-trip — and it is the specific call that has **403'd real deploys**: GHCR intermittently returns `403` on a manifest request even with valid auth (confirmed on `substitute-teacher-helper` run `29856271428`, where `docker pull` succeeded and the *identical* ref then `403`'d on the redundant pull). This deploy is one flaky GHCR moment from that same failure.

The 403 is **per request**, so pull #1 is exposed to the same flake too — with no retry, and using a login written into the shared `/root/.docker/config.json` (which can carry a stale token from a prior run or be clobbered by a concurrent deploy — a failure mode documented in the VPS deploy notes). Removing only pull #2 would halve the exposure while leaving pull #1's flake, its missing retry, and the shared-config login untouched. The fleet already has a single, correct home for all of this — so the right fix is not to patch push-hub's copy but to stop keeping a copy.

**Goal (as adopted):** push-hub's deploy makes exactly **one** GHCR round-trip — `up` reuses the image already pulled by pull #1, instead of re-pulling it via `docker compose pull`. A retried pull and an isolated GHCR credential (available by delegating to the shared `/opt/apps/deploy.sh`) were Approach A's additional benefits on top of that; both are declined along with Approach A — see Decision.

---

## Current state (verified)

- **Workflow:** `.github/workflows/deploy.yml` — build+push to `ghcr.io/tayl0r/push-hub:{dev,prod}`, then an `appleboy/ssh-action` step running the inline script above. Host and SSH creds come from the `dev`/`prod` GitHub Environments; `DEPLOY_DIR` and `DEPLOY_NETWORK` are additional Environment secrets (whose *values* GitHub will not read back, but whose ground truth is observable on the host — see below).
- **Live VPS reality (inspected over SSH, 2026-07-21):**
  - Deploy dirs are `/opt/apps/push-hub` (prod) and `/opt/apps/push-hub-dev` (dev). So `DEPLOY_DIR` is a full path under `/opt/apps/`; its basename is `push-hub` / `push-hub-dev`.
  - Both **live** compose files are **single-service**, `image: ghcr.io/tayl0r/push-hub:{prod,dev}` (= the `$IMAGE` the explicit pull fetches), and attach the service to a compose-local network aliased `internal` whose real Docker network is **`apps_internal`** (`networks: internal: {external: true, name: apps_internal}`). The repo template's bare `internal` was a template detail, not the live network name.
  - `apps-postgres-1` is attached to `apps_internal`; both `.env` files set `DATABASE_URL=…@apps-postgres-1:5432`. So the migrate must run on `apps_internal` to reach the DB — and current deploys succeed (both containers Up). Therefore `DEPLOY_NETWORK` **is** `apps_internal`.
- **Shared script (verified present on VPS 2026-07-21):** `/opt/apps/deploy.sh` (canonical source: `tayl0r/vps` `deploy/app-deploy.sh`). Signature `deploy.sh <compose-dir> <image-ref> [migrate-cmd ...]`. It:
  1. requires `/opt/apps/<compose-dir>/docker-compose.yml` (else `exit 1`);
  2. creates an isolated throwaway `DOCKER_CONFIG=$(mktemp -d)` and does its own `docker login` — never touching `/root/.docker/config.json`;
  3. pulls **once, retried up to 3×** (covers the transient GHCR `403` and one-off containerd extract errors);
  4. if a migrate command is given, runs it via `docker run --rm --network apps_internal --env-file /opt/apps/<compose-dir>/.env "$IMAGE" "$@"`;
  5. `cd /opt/apps/<compose-dir> && docker compose up -d --pull never && docker image prune -f`.
- **Fleet doctrine (`tayl0r/vps` `DEPLOY.md`):** the server-side half of every deploy is "shared infrastructure, exactly like Postgres or Traefik — one copy on the VPS, not a snippet re-pasted into each app." It names isolated login + single-pull-with-retry + `up --pull never` as behaviors the script owns, each born from a real failure, and states plainly: **"This is why an app must never add its own `docker compose pull`."** push-hub currently violates this.
- **Reference adoption:** `substitute-teacher-helper#7` — merged, green on this same VPS (`Migrations applied`, zero second round-trip) — collapsed its inline script to a single `/opt/apps/deploy.sh` call and **dropped its deploy-dir/network secrets**, hardcoding the per-env dir name as plain workflow env.

---

## Approaches considered

Both remove the redundant second pull, so both fix the issue's literal symptom. They differ in whether push-hub keeps its own deploy logic or converges on the fleet's shared seam.

### Approach A — Adopt the shared `/opt/apps/deploy.sh` (the review's recommendation — DECLINED, see Decision)

*(Declined: the user chose Approach B instead, specifically to avoid a runtime dependency on the `tayl0r/vps`-owned script — see Decision. The analysis below is retained as the reasoned record of what was considered, not as the adopted plan.)*

Replace the inline SSH `script:` with a call to the shared script, mirroring the reference adoption. push-hub's deploy dir is chosen per environment as plain workflow env (`push-hub` / `push-hub-dev`), and the two now-redundant secrets are dropped. See "The change" for the exact YAML.

```yaml
    env:
      DIR: ${{ github.ref_name == 'prod' && 'push-hub' || 'push-hub-dev' }}
    # …
          script: |
            export GITHUB_TOKEN GITHUB_ACTOR
            /opt/apps/deploy.sh "$DIR" "$IMAGE" pnpm db:migrate
```

- **Solves the issue?** Yes — the script is the *only* thing that pulls, exactly once, and `up --pull never` reuses that image. The redundant `docker compose pull` is gone.
- **Beyond the symptom (all correct-by-default, none opt-in):** the single pull is **retried**, so the transient 403/extract flake self-heals instead of failing the deploy; the GHCR credential is **isolated** in a throwaway `DOCKER_CONFIG`, ending the stale-token / concurrent-clobber exposure of the shared `/root/.docker/config.json`.
- **Shared-boundary fix (the rubric's core case):** the deploy workflow is one of a known family — every app on this VPS deploys through `/opt/apps/deploy.sh`. Fixing push-hub's *copy* leaves it the one divergent member the next deploy-logic change (next GHCR quirk, retry tuning) must be remembered for. Delegating puts push-hub on the shared seam, so it inherits fleet fixes for free.
- **Blast radius, de-risked to fact:** the change touches one file; its failure modes are all loud aborts (missing compose file → `exit 1`; migrate can't reach DB → non-zero exit before `up`); it is rehearsable pre-merge (`workflow_dispatch` → dev environment, see Verification); the identical pattern is already green on this VPS via `#7`.
- **Cost:** a runtime dependency on the on-VPS script — but push-hub already depends on VPS state (deploy dir, `.env`, live compose, the `apps_internal` network, `apps-postgres-1`); the script is doctrine-designated shared infrastructure like Postgres itself. This is convergence, not new coupling.

### Approach B — Minimal inline patch (ADOPTED, see Decision)

*(Adopted: despite the analysis below arguing Approach A is strictly stronger, the user chose this minimal, self-contained patch anyway — see Decision. The "rejected" reasoning that follows is the adversarial review's case against B; it is retained unchanged as the reasoned record, not a live objection.)*

Delete the `docker compose pull` line and pin the `up` to the local image, leaving the rest of the inline script in place:

```diff
             cd "$DEPLOY_DIR"
-            docker compose pull
-            docker compose up -d
+            docker compose up -d --pull never
             docker image prune -f
```

This is a correct two-line change and does remove the redundant pull. It is **rejected** because, once the VPS ground truth is known, it is strictly the weaker endpoint:

1. **It half-fixes the flake.** Pull #1 keeps no retry and keeps the shared-config `/root/.docker/config.json` login; the doc's own "one flaky GHCR moment from failure" stays true. Approach A removes *both* dice-rolls and the shared-config login.
2. **It re-affirms a per-app copy of shared logic** at exactly the boundary the fleet doctrine reserves for `/opt/apps/deploy.sh` ("an app must never add its own `docker compose pull`" — and `--pull never` is that same owned behavior). push-hub stays the divergent member.
3. **Its original justifications were disproven.** The earlier case for Minimal rested on Approach A being risky — a possible network mismatch, unverifiable secrets, and "no way to dry-run." VPS inspection refuted all three: the migrate network *is* `apps_internal` (matches the script's hardcode, no `tayl0r/vps` change needed), the deploy dirs are known, and `workflow_dispatch` → dev is a real pre-merge rehearsal. With those gone, Minimal's only remaining advantage — a marginally smaller diff — is not a design virtue (and effort is not a decision factor here).

A "Minimal **+** inline retry loop" middle option was also considered and rejected: it would re-implement the script's owned retry inside push-hub — a divergent copy of shared infrastructure, the worst of both worlds.

Minimal survives only in the trivial sense that reverting the Approach-A PR restores today's behavior minus one line; it is not a live fallback.

---

## Recommendation

> **SUPERSEDED by the Decision above (2026-07-22): the user adopted Approach B.** The Approach-A recommendation below is the adversarial review's analysis, kept as the reasoned record — not the adopted plan.

**[Review's recommendation — declined] Adopt Approach A.** It fixes the issue's redundant-pull bug *and* resolves the root flake (retry + isolated credential), it is the shared-boundary fix the rubric prefers for a known family, and every risk that once argued against it has been verified away against the live VPS. It is a single-file change, mirrors a pattern already proven green on this VPS, and deletes two now-meaningless secrets.

---

## The change (adopted — Approach B, exact)

Two lines in `.github/workflows/deploy.yml`'s `Migrate and deploy` SSH `script:` — delete the redundant `docker compose pull`, and pin `up` to the already-local image (fetched by the explicit `docker pull "$IMAGE"` that runs just above) with `--pull never`:

```diff
             cd "$DEPLOY_DIR"
-            docker compose pull
-            docker compose up -d
+            docker compose up -d --pull never
             docker image prune -f
```

Nothing else changes: the explicit `docker pull "$IMAGE"`, the migrate `docker run`, the `DEPLOY_DIR`/`DEPLOY_NETWORK` secrets, the top-of-file comment, and every other job stay exactly as they are. Because the inline script still reads `DEPLOY_DIR`/`DEPLOY_NETWORK`, the Approach-A follow-up to delete those secrets (**#5**) does **not** apply under Approach B — #5 should be closed.

---

## The change — Approach A (reference only; NOT adopted)

Replace the whole of `.github/workflows/deploy.yml` job body's SSH step and the surrounding `env:` with the following (unchanged parts — `on:`, `permissions:`, `concurrency:`, `environment:`, checkout, GHCR login, build-push — stay as they are; push-hub keeps its `workflow_dispatch`, `concurrency` group, and Environment-scoped `environment:` key, which the reference app does not have):

```yaml
    env:
      IMAGE_TAG: ${{ github.ref_name == 'prod' && 'prod' || 'dev' }}
      DIR: ${{ github.ref_name == 'prod' && 'push-hub' || 'push-hub-dev' }}
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          provenance: false
          tags: ghcr.io/tayl0r/push-hub:${{ env.IMAGE_TAG }}

      - name: Migrate and deploy
        uses: appleboy/ssh-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_ACTOR: ${{ github.actor }}
          IMAGE: ghcr.io/tayl0r/push-hub:${{ env.IMAGE_TAG }}
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          envs: GITHUB_TOKEN,GITHUB_ACTOR,IMAGE,DIR
          # Shared fleet deploy logic lives in /opt/apps/deploy.sh on the VPS
          # (canonical copy: tayl0r/vps deploy/app-deploy.sh) — isolated GHCR
          # login, single pull with retry, migrate, then `up -d --pull never`,
          # then image prune. Args 3+ are this app's migrate command; the script
          # runs it in the freshly pulled image (which carries devDeps + src/ —
          # see Dockerfile) on the apps_internal network with /opt/apps/$DIR/.env.
          script: |
            export GITHUB_TOKEN GITHUB_ACTOR
            /opt/apps/deploy.sh "$DIR" "$IMAGE" pnpm db:migrate
```

Deltas from today: the `DEPLOY_DIR` and `DEPLOY_NETWORK` secrets vanish from `env:` and `envs:`; a plain `DIR` per-env variable and an explicit `GITHUB_ACTOR` are added; the whole inline `set -e` / login / pull / migrate / `compose pull` / `up` / prune body collapses to the single script call (the script owns its own `set -euo pipefail` and error handling). The top-of-file comment block should be updated to describe the shared-script deploy (the two secrets it references no longer exist). Also add the file to the `on:` `workflow_dispatch` trigger if not already present (it is, today) so the pre-merge rehearsal below is available.

---

## Verification & success criteria

The goal ("exactly one GHCR round-trip") is checkable directly against the deploy-step log. There is no separate `deploy.sh`-mediated dry run under Approach B — validation is the deploy itself, dev first, since there is no unit test for a CI-workflow edit.

**Deploy validation (dev then prod):** merging to `main` deploys **dev** only; **prod** deploys only on a push to the `prod` branch — so dev is always exercised first. After each, confirm the deploy-step log shows the explicit `docker pull "$IMAGE"`, then the migrate, then **no** `Pulling`/`docker compose pull` output before `up -d --pull never`; and confirm `docker ps` shows `push-hub-dev-push-hub-1` Up on the new image digest (and, after the prod push, `push-hub-push-hub-1` likewise).

**Post-merge cleanup:** N/A under the adopted Approach B — the inline script still reads `DEPLOY_DIR`/`DEPLOY_NETWORK`, so they stay in use and are NOT deleted. (Issue **#5**, which proposed deleting them, was specific to Approach A and is now closed — see "Out of scope / follow-ups".)

---

## Assumptions

Most of what would have been assumed was instead **verified** against the live VPS (recorded under "Current state"): the deploy dirs (`/opt/apps/push-hub{,-dev}`), the migrate network (`apps_internal`, matching the script's hardcode), the single-service live compose files, and the image refs (`ghcr.io/tayl0r/push-hub:{prod,dev}` = `$IMAGE`). What remains genuinely unverifiable, stated honestly:

- **A1 — SSH Environment secrets (`SSH_HOST`/`SSH_USER`/`SSH_PRIVATE_KEY`) are valid.** Untouched by this change; today's green deploys are the standing evidence. Applies under the adopted Approach B.
- **A2 — `/opt/apps/deploy.sh` stays signature-stable.** Approach-A-only: this would matter only if push-hub delegated to the shared script. Approach A was declined specifically to avoid that coupling (see Decision), so under the adopted Approach B push-hub takes no dependency on `deploy.sh`'s signature at all — this assumption does not apply to the live plan.
- **A3 — `DEPLOY_DIR` / `DEPLOY_NETWORK` values were inferred, not read back.** Their ground truth (`/opt/apps/push-hub{,-dev}`, `apps_internal`) is established to practical certainty from live topology + working deploys. Under the adopted Approach B the secrets are kept, not dropped (see "Out of scope / follow-ups"), so this inferred-not-read-back status remains a live, accepted assumption rather than one Approach A would have mooted.

No blocking ambiguity remains: every fork was resolved against verified fact or a doctrine-backed default.

---

## Risks & mitigations

- **Local image somehow absent at `up`.** The patched `up -d --pull never` fails loudly rather than silently re-pulling — and it is only reached *after* the explicit `docker pull "$IMAGE"` (pull #1) and the migrate `docker run` against that same image have already succeeded under the script's `set -e`, so in practice the ref is always local. Fail-fast and diagnosable; no mitigation needed.
- **Migrate cannot reach the DB.** Only if the migrate network were not `apps_internal` — verified it is (`apps-postgres-1` lives there; deploys work today). Would surface as a loud non-zero exit before `up`, caught when dev deploys first (before prod).
- **Wrong/missing deploy dir.** `cd "$DEPLOY_DIR"` fails loudly under `set -e` if the path is wrong; `DEPLOY_DIR` is an existing, host-verified Environment secret left untouched by this patch, and any error is loud and caught on the dev deploy that always runs first.
- **Shared-script regression from `tayl0r/vps`.** N/A under the adopted Approach B — this risk applied only to Approach A's dependency on `/opt/apps/deploy.sh`, declined along with A (see Decision). The adopted inline patch has no shared-script dependency to regress.

---

## Out of scope / follow-ups

- **tayl0r/push-hub#5** — **closed; not applicable under the adopted Approach B.** It proposed deleting the `DEPLOY_DIR` / `DEPLOY_NETWORK` Environment secrets, which was only safe under Approach A (whose shared-script call never reads them). Approach B's inline script still reads both directly, so they remain in use and must NOT be deleted.
- No changes to the build/push job, the migrate command, the compose files, the shared script, or any other VPS host config. Had the migrate network *not* been `apps_internal`, the correct resolution would have been to add an optional, `apps_internal`-defaulting network arg to the shared `tayl0r/vps` script (not to fork push-hub) — but ground truth removed that fork.

---

## Spec self-review

- **Placeholders:** none — the exact final YAML is inline; no TODO/TBD.
- **Internal consistency:** the Decision, "The change (adopted — Approach B, exact)", the verification steps, the assumptions, and the follow-ups all describe the same single Approach-B adoption; Approach A is retained in full as the adversarial review's recommendation but is consistently marked declined (title, headers, Recommendation section, Decision), never presented as active; the #5 secret-deletion follow-up is stated once, marked closed/not-applicable under B, without contradiction.
- **Scope creep:** none — one file changes, two lines; the migrate command, compose files, secrets, and shared script are all explicitly untouched. The only adjacent action ever on the table — deleting the `DEPLOY_DIR`/`DEPLOY_NETWORK` secrets — was Approach-A-specific and is now moot: under the adopted Approach B those secrets stay in use, and the issue that proposed deleting them (**#5**) is closed, not deferred.
- **Ambiguity:** the A-vs-B fork is resolved with a rubric- and fact-tied recommendation; every prior "unverifiable" was replaced with a verified fact or an honestly-labeled residual assumption; the change is specified as complete YAML, so an implementer has one interpretation.
