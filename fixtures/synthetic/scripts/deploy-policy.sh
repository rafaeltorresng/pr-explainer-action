#!/usr/bin/env bash
set -euo pipefail

# This script synchronizes deploy policy rules via API PATCH.
# It does NOT perform any container builds or immediate deployments.
ENDPOINT="${POLICY_API_URL:-https://internal.company.net/api/v1/policy}"
echo "Updating policy rules for environment: ${POLICY_ENV:-staging}"

curl -sSf -X PATCH "${ENDPOINT}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${POLICY_TOKEN:-mock}" \
  -d '{"autoRollback": true, "maxCanaryDurationMinutes": 15}'

echo "Policy synchronization acknowledged."
