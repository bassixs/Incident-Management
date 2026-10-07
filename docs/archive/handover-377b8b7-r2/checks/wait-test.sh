#!/usr/bin/env bash
set -euo pipefail
stage=$(cd "$(dirname "$0")" && pwd)
fake=$(mktemp -d "$stage/fake-docker.XXXXXX")
cat > "$fake/docker" <<'SH'
#!/usr/bin/env bash
case "$WAIT_TEST_MODE" in
 delayed) count=$(cat "$WAIT_TEST_COUNTER" 2>/dev/null || echo 0); count=$((count+1)); echo "$count" > "$WAIT_TEST_COUNTER"; ((count >= 3));;
 failed) exit 1;;
 hang) sleep 20;;
 *) exit 7;;
esac
SH
chmod +x "$fake/docker"
export PATH="$fake:$PATH" WAIT_TEST_COUNTER="$fake/count"
helper="$stage/config/wait-ready.sh"
bash -n "$helper"
WAIT_TEST_MODE=delayed WAIT_READY_SECONDS=8 bash "$helper" > "$stage/wait-delayed.log" 2>&1
grep -q 'health=200 ready=200' "$stage/wait-delayed.log"
test "$(cat "$WAIT_TEST_COUNTER")" -eq 3
for mode in failed hang; do
 start=$SECONDS
 if WAIT_TEST_MODE=$mode WAIT_READY_SECONDS=2 bash "$helper" > "$stage/wait-$mode.log" 2>&1; then echo 'Unexpected success'; exit 1; else status=$?; fi
 test "$status" -eq 1
 test "$((SECONDS-start))" -le 4
 grep -q 'ERROR: app did not reach health=200 and ready=200 within 2 seconds' "$stage/wait-$mode.log"
done
if WAIT_READY_SECONDS=0 bash "$helper" > "$stage/wait-invalid.log" 2>&1; then exit 1; else test "$?" -eq 2; fi
printf '{"delayedReadyPassed":true,"notReadyBounded":true,"hungDockerBounded":true,"invalidLimitRejected":true,"realDockerCalls":0}\n'
