#!/usr/bin/env bash
# Rotate a push-hub tenant's API key (operator leak-recovery path).
#
# Self-service registration issues keys automatically (POST /v1/tenants) — you do NOT
# need this for normal onboarding. Use it only to rotate a leaked key out of band: it
# generates a fresh key + its SHA-256 hash and prints the SQL to point an existing tenant
# row at the new hash. Apply the UPDATE, then RESTART the container — the running process
# serves tenants from an in-memory map that is rebuilt only at boot.
#
#   Usage: scripts/new-tenant-key.sh <app-slug>
set -euo pipefail

slug="${1:?usage: new-tenant-key.sh <app-slug>}"
key="phk_$(openssl rand -hex 24)"
# printf '%s' (not echo) so no trailing newline is hashed — must match Node's
# createHash('sha256').update(key).digest('hex') over the exact key string.
# Prefer sha256sum (Linux/VPS); fall back to shasum -a 256 (macOS).
if command -v sha256sum >/dev/null 2>&1; then
  hash="$(printf '%s' "$key" | sha256sum | cut -d' ' -f1)"
else
  hash="$(printf '%s' "$key" | shasum -a 256 | cut -d' ' -f1)"
fi

cat <<EOF
tenant slug : ${slug}
new API key : ${key}
              ^ give this to the ${slug} app (its .env); never commit it
apiKeyHash  : ${hash}

Apply on the push-hub database, then restart the container:

  UPDATE tenants SET api_key_hash = '${hash}', updated_at = now() WHERE slug = '${slug}';
EOF
