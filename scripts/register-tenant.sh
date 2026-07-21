#!/usr/bin/env bash
# register-tenant.sh — register an app as a push-hub tenant (self-service provisioning).
#
# Assembles the POST /v1/tenants body from an APNs .p8 and/or a Firebase
# service-account JSON — handling the base64 encoding + JSON escaping that are
# easy to get wrong by hand — and calls push-hub with the enroll key. Prints the
# once-shown per-tenant API key (phk_…) to drop into the app's own .env.
#
# push-hub is internal-network only, so run this where push-hub is reachable:
# on the VPS with `--network <docker-net>` (wraps curl in a throwaway container
# on that network), or from inside a container already on that network.
#
#   PUSH_HUB_ENROLL_KEY=<the env's enroll key>  scripts/register-tenant.sh <slug> --env dev|prod [provider opts]
#
# Provider blocks (at least one is required):
#   APNs (all four together): --p8 <AuthKey.p8> --key-id <id> --team-id <id> --bundle <bundleId>
#   FCM:                      --firebase <service-account.json>
# Options:
#   --env dev|prod      (required) picks the push-hub URL + APNs production flag
#   --url <url>         override the push-hub base URL (default per --env)
#   --network <name>    run curl inside `docker run --network <name>` (reach internal-only push-hub)
#   --production <bool> override the APNs production flag (default: prod=true, dev=false)
#   --dry-run           print the request (enroll key redacted) instead of sending it
#
# Requires: jq, curl (and docker if --network is used). The enroll key comes from
# $PUSH_HUB_ENROLL_KEY (never a flag), matching the dev/prod key in DEPLOY.md.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

slug=""; env=""; url=""; network=""; production=""
p8=""; key_id=""; team_id=""; bundle=""; firebase=""; dry_run=""

while [ $# -gt 0 ]; do
  case "$1" in
    --env)        env="${2:-}"; shift 2 ;;
    --url)        url="${2:-}"; shift 2 ;;
    --network)    network="${2:-}"; shift 2 ;;
    --production) production="${2:-}"; shift 2 ;;
    --p8)         p8="${2:-}"; shift 2 ;;
    --key-id)     key_id="${2:-}"; shift 2 ;;
    --team-id)    team_id="${2:-}"; shift 2 ;;
    --bundle)     bundle="${2:-}"; shift 2 ;;
    --firebase)   firebase="${2:-}"; shift 2 ;;
    --dry-run)    dry_run=1; shift ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    -*)           die "unknown option: $1" ;;
    *)            if [ -z "$slug" ]; then slug="$1"; shift; else die "unexpected arg: $1"; fi ;;
  esac
done

command -v jq >/dev/null || die "jq is required"
[ -n "$slug" ] || die "usage: register-tenant.sh <slug> --env dev|prod [provider opts]  (see --help)"
[[ "$slug" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
  || die "slug '$slug' is not a valid DNS-1123 label (a-z, 0-9, hyphens; start/end alphanumeric; <=63 chars)"

# push-hub URL + APNs production flag follow the environment
case "$env" in
  dev)  : "${url:=http://push-hub-dev:3000}"; : "${production:=false}" ;;
  prod) : "${url:=http://push-hub:3000}";     : "${production:=true}"  ;;
  *)    die "--env must be dev or prod" ;;
esac
[ "$production" = "true" ] || [ "$production" = "false" ] || die "--production must be true or false"

# APNs block (all four fields required together, or none)
signing_key=""
if [ -n "$p8$key_id$team_id$bundle" ]; then
  [ -n "$p8" ] && [ -n "$key_id" ] && [ -n "$team_id" ] && [ -n "$bundle" ] \
    || die "APNs needs all of --p8 --key-id --team-id --bundle"
  [ -f "$p8" ] || die "no such .p8 file: $p8"
  grep -q 'BEGIN PRIVATE KEY' "$p8" || die "$p8 doesn't look like a .p8 (no 'BEGIN PRIVATE KEY')"
  signing_key=$(base64 < "$p8" | tr -d '\n')   # signingKey = base64 of the .p8 (newlines stripped)
fi

# FCM block from the service-account JSON (jq extracts + the body-builder re-escapes the key)
f_project=""; f_email=""; f_key=""
if [ -n "$firebase" ]; then
  [ -f "$firebase" ] || die "no such firebase json: $firebase"
  f_project=$(jq -re '.project_id'   "$firebase") || die "firebase json: missing project_id"
  f_email=$(jq -re   '.client_email' "$firebase") || die "firebase json: missing client_email"
  f_key=$(jq -re     '.private_key'  "$firebase") || die "firebase json: missing private_key"
fi

[ -n "$signing_key" ] || [ -n "$f_project" ] \
  || die "at least one provider required: --p8 group and/or --firebase"

# jq builds the body so all escaping (esp. the FCM private_key newlines) is correct
body=$(jq -nc \
  --arg slug "$slug" \
  --arg keyId "$key_id" --arg teamId "$team_id" --arg bundle "$bundle" \
  --arg signingKey "$signing_key" --argjson production "$production" \
  --arg fProject "$f_project" --arg fEmail "$f_email" --arg fKey "$f_key" \
  '{slug:$slug}
   + (if $signingKey != "" then {apns:{keyId:$keyId,teamId:$teamId,bundleId:$bundle,signingKey:$signingKey,production:$production}} else {} end)
   + (if $fProject   != "" then {fcm:{projectId:$fProject,clientEmail:$fEmail,privateKey:$fKey}} else {} end)')

echo "→ register '$slug' on $env  ($url, apns.production=$production)" >&2

if [ -n "$dry_run" ]; then
  echo "DRY RUN — would POST $url/v1/tenants  (Authorization: Bearer <redacted>)" >&2
  printf '%s\n' "$body" | jq .
  exit 0
fi

[ -n "${PUSH_HUB_ENROLL_KEY:-}" ] || die "set PUSH_HUB_ENROLL_KEY to the $env enroll key (see DEPLOY.md)"

run_curl() {
  if [ -n "$network" ]; then
    docker run --rm -i --network "$network" curlimages/curl:latest "$@"
  else
    curl "$@"
  fi
}

resp=$(printf '%s' "$body" | run_curl -sS -w $'\n%{http_code}' \
  -X POST "$url/v1/tenants" \
  -H "Authorization: Bearer $PUSH_HUB_ENROLL_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @-) \
  || die "request failed — is push-hub reachable at $url? On the VPS use --network <docker-net>."

code=$(printf '%s' "$resp" | tail -n1)
out=$(printf '%s' "$resp" | sed '$d')

if [ "$code" = "201" ]; then
  api_key=$(printf '%s' "$out" | jq -re '.apiKey')
  echo
  echo "✓ registered '$slug' on $env — API key (shown ONCE; put in the app's .env, never commit):"
  echo
  echo "    $api_key"
  echo
else
  echo "✗ registration failed (HTTP $code):" >&2
  printf '%s\n' "$out" | jq . 2>/dev/null >&2 || printf '%s\n' "$out" >&2
  exit 1
fi
