---
dev-flow:
  slug: deploy-single-pull
  stops: [post-design, pre-merge]
---

# push-hub — Deploy: adopt the shared `/opt/apps/deploy.sh` (kills the redundant pull)

**Date:** 2026-07-21
**Issue:** tayl0r/push-hub#4
**Status:** design under adversarial review
**Scope:** One CI file (`.github/workflows/deploy.yml`). Replace push-hub's inline SSH deploy script with a call to the fleet's shared VPS deploy script, `/opt/apps/deploy.sh`. This removes the redundant second GHCR pull (the issue's stated bug) and, in the same move, brings push-hub's deploy onto the same correct-by-default seam every other app on the VPS already uses. No application-code or VPS-host changes; the shared script already exists on the host.

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

**Goal:** push-hub's deploy makes exactly **one** GHCR round-trip, that round-trip is retried, its credential is isolated, and `up` reuses the already-local image — by delegating to the shared script rather than re-implementing it.

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

### Approach A — Adopt the shared `/opt/apps/deploy.sh` (RECOMMENDED)

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

### Approach B — Minimal inline patch (rejected alternative)

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

**Adopt Approach A.** It fixes the issue's redundant-pull bug *and* resolves the root flake (retry + isolated credential), it is the shared-boundary fix the rubric prefers for a known family, and every risk that once argued against it has been verified away against the live VPS. It is a single-file change, mirrors a pattern already proven green on this VPS, and deletes two now-meaningless secrets. Approach B is retained above only as the recorded rejected alternative.

---

## The change (Approach A, exact)

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

The goal ("exactly one GHCR round-trip") is checkable, and the change is rehearsable before it can touch prod.

**Pre-merge rehearsal (dev, zero prod risk):** from the feature branch, `workflow_dispatch` the workflow. `environment:` resolves to `dev` for any non-`prod` ref, so this runs the full new path against `push-hub-dev`. Expect: green run; the deploy step log shows `deploy.sh` performing a single `docker pull` (with its retry framing) and **no** `Pulling`/`docker compose pull` output between the migrate and container start; a migrate line indicating success; `up -d --pull never`. This is the same pattern `substitute-teacher-helper#7` already ran green on this VPS.

**Post-merge, dev then prod:** merging to `main` deploys **dev** only; **prod** deploys only on push to the `prod` branch — so dev is always exercised first. After each, confirm on the host: `docker ps` shows `push-hub{-,-dev}-push-hub-1` Up on the freshly pushed image digest, and the deploy-step log shows exactly one pull and no second round-trip.

**Post-merge cleanup (tracked, non-blocking):** after the first green dev **and** prod deploys, delete the now-unreferenced `DEPLOY_DIR` / `DEPLOY_NETWORK` secrets from both Environments — filed as **tayl0r/push-hub#5** so it survives session boundaries. It must not be done earlier: the pre-merge `main` workflow still reads them.

---

## Assumptions

Most of what would have been assumed was instead **verified** against the live VPS (recorded under "Current state"): the deploy dirs (`/opt/apps/push-hub{,-dev}`), the migrate network (`apps_internal`, matching the script's hardcode), the single-service live compose files, and the image refs (`ghcr.io/tayl0r/push-hub:{prod,dev}` = `$IMAGE`). What remains genuinely unverifiable, stated honestly:

- **A1 — SSH Environment secrets (`SSH_HOST`/`SSH_USER`/`SSH_PRIVATE_KEY`) are valid.** Untouched by this change; today's green deploys are the standing evidence.
- **A2 — `/opt/apps/deploy.sh` stays signature-stable.** It is owned by `tayl0r/vps` and doctrine-designated shared infrastructure; push-hub cannot pin its version, exactly as it cannot pin the shared Postgres. Accepted as the same class of dependency the whole fleet takes.
- **A3 — `DEPLOY_DIR` / `DEPLOY_NETWORK` values were inferred, not read back.** Their ground truth (`/opt/apps/push-hub{,-dev}`, `apps_internal`) is established to practical certainty from live topology + working deploys, and Approach A makes the values irrelevant by dropping the secrets.

No blocking ambiguity remains: every fork was resolved against verified fact or a doctrine-backed default.

---

## Risks & mitigations

- **Local image somehow absent at `up`.** `deploy.sh` uses `--pull never`, so `up` fails loudly rather than silently re-pulling — and it is only reached *after* the script's pull and migrate (same image) have succeeded under `set -euo pipefail`, so in practice the ref is always local. Fail-fast and diagnosable; no mitigation needed.
- **Migrate cannot reach the DB.** Only if the migrate network were not `apps_internal` — verified it is (`apps-postgres-1` lives there; deploys work today). Would surface as a loud non-zero exit before `up`, caught by the dev rehearsal.
- **Wrong/missing deploy dir.** The script `exit 1`s on a missing `/opt/apps/$DIR/docker-compose.yml`; `DIR` is a hardcoded, host-verified name, and any error is loud and caught pre-merge.
- **Shared-script regression from `tayl0r/vps`.** A fleet-wide concern by design, not a reason for push-hub alone to keep a divergent copy; mitigated by the same rehearsal path every app has.

---

## Out of scope / follow-ups

- **tayl0r/push-hub#5** — delete the unused `DEPLOY_DIR` / `DEPLOY_NETWORK` Environment secrets after the first green dev + prod deploys (non-blocking; filed).
- No changes to the build/push job, the migrate command, the compose files, the shared script, or any other VPS host config. Had the migrate network *not* been `apps_internal`, the correct resolution would have been to add an optional, `apps_internal`-defaulting network arg to the shared `tayl0r/vps` script (not to fork push-hub) — but ground truth removed that fork.

---

## Spec self-review

- **Placeholders:** none — the exact final YAML is inline; no TODO/TBD.
- **Internal consistency:** the recommendation, the exact change, the verification steps, and the assumptions all describe the same single Approach-A adoption; Approach B is consistently framed as the rejected alternative, never partially adopted; secret-dropping is stated once in the change and once (with the guard against premature deletion) in verification, without contradiction.
- **Scope creep:** none — one file changes; the migrate command, compose files, and shared script are explicitly untouched; the one adjacent action (deleting dead secrets) is deferred to a filed, non-blocking issue rather than smuggled in.
- **Ambiguity:** the A-vs-B fork is resolved with a rubric- and fact-tied recommendation; every prior "unverifiable" was replaced with a verified fact or an honestly-labeled residual assumption; the change is specified as complete YAML, so an implementer has one interpretation.
