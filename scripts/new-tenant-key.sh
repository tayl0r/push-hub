#!/usr/bin/env bash
# Provision a push-hub tenant key for an app.
#
# Generates an opaque API key + its SHA-256 hash (matching how push-hub hashes:
# sha256 of the raw key string, NO trailing newline), and prints a PUSH_HUB_TENANTS
# skeleton to fill in with that app's APNs/FCM credentials.
#
#   Usage: scripts/new-tenant-key.sh <app-slug>
#
# Give the printed "API key" to the app (its own .env / secret store) — never commit it.
# Put the "apiKeyHash" (only) into PUSH_HUB_TENANTS in push-hub's server .env.
set -euo pipefail

slug="${1:?usage: new-tenant-key.sh <app-slug>}"
key="phk_$(openssl rand -hex 24)"
# printf '%s' (not echo) so no trailing newline is hashed — must match Node's
# createHash('sha256').update(key).digest('hex') over the exact key string.
hash="$(printf '%s' "$key" | shasum -a 256 | cut -d' ' -f1)"

cat <<EOF
tenant slug : ${slug}
API key     : ${key}
              ^ give this to the ${slug} app (its .env); never commit it
apiKeyHash  : ${hash}
              ^ put this in PUSH_HUB_TENANTS (push-hub server .env only)

PUSH_HUB_TENANTS entry — fill apns/fcm from the app's Apple Developer / Firebase consoles
(each provider is optional, but at least one is required):

  {
    "slug": "${slug}",
    "apiKeyHash": "${hash}",
    "apns": { "keyId": "...", "teamId": "...", "bundleId": "com.example.${slug}",
              "signingKey": "<base64 of the .p8 file>", "production": true },
    "fcm":  { "projectId": "...", "clientEmail": "...", "privateKey": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n" }
  }
EOF
