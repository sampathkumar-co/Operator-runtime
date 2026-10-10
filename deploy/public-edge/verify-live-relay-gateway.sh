#!/bin/sh
# Verify the public Mecord gateway after a production rollout.
# Requires curl, Docker, and the Node executable INSIDE the operator-edge
# container. No Node installation is required on the VPS host.
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <running-operator-edge-container> <expected-40-character-commit>" >&2
  exit 64
fi
container=$1
expected=$2

case "$container" in
  ''|*[!a-zA-Z0-9_.-]*)
    echo "Invalid container name" >&2
    exit 64
    ;;
esac
case "$expected" in
  ''|*[!a-fA-F0-9]*)
    echo "Expected commit must be a full SHA-1 hex string" >&2
    exit 64
    ;;
esac
if [ "${#expected}" -ne 40 ]; then
  echo "Expected commit must contain exactly 40 hex characters" >&2
  exit 64
fi

for command_name in curl docker mktemp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required host command unavailable: $command_name" >&2
    exit 69
  fi
done

health_file=$(mktemp)
trap 'rm -f "$health_file"' EXIT HUP INT TERM
curl --fail --silent --show-error --max-time 20 \
  --output "$health_file" \
  'https://operator.splcart.in/health'

# JSON is parsed by Node in the existing application container, never on
# the VPS host. A wrong source hash or unhealthy payload fails the rollout.
docker exec -i "$container" node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const health = JSON.parse(raw);
    const expected = process.argv[1];
    if (health === null || typeof health !== "object"
        || health.ok !== true
        || health.service !== "mecord-connect"
        || health.sourceCommit !== expected) {
      process.stderr.write("Public health JSON did not confirm the candidate commit and service.\\n");
      process.exitCode = 1;
      return;
    }
    process.stdout.write("Production health and source commit verified.\\n");
  } catch {
    process.stderr.write("Production health response was not valid JSON.\\n");
    process.exitCode = 1;
  }
});
' "$expected" < "$health_file"

# The endpoint must reach the authenticated relay result service and refuse
# anonymous requests. Never submit credentials as part of this check.
authority_status=$(curl --silent --show-error --max-time 20 \
  --output /dev/null --write-out '%{http_code}' \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  'https://operator.splcart.in/v1/device-authority/check')
if [ "$authority_status" != 401 ]; then
  echo "Authority route mismatch: expected unauthenticated HTTP 401, got $authority_status" >&2
  exit 1
fi

echo "Public relay gateway verification passed; authenticated acceptance remains required."
