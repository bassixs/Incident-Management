#!/usr/bin/env bash
# Run from ~/incident-transfer/project/. Does not start or restart containers.
set -u
limit=${WAIT_READY_SECONDS:-120}
if [[ ! $limit =~ ^[0-9]+$ ]] || ((10#$limit < 1 || 10#$limit > 600)); then
  echo 'WAIT_READY_SECONDS must be an integer from 1 to 600.' >&2; exit 2
fi
limit=$((10#$limit))
command -v timeout >/dev/null || { echo 'Install GNU coreutils (timeout) before the update.' >&2; exit 2; }
deadline=$((SECONDS + limit))
while ((SECONDS < deadline)); do
  remaining=$((deadline - SECONDS)); slice=$remaining
  ((slice > 8)) && slice=8
  if timeout --kill-after=1s "${slice}s" docker compose -p incident-bot -f docker-compose.yml exec -T app node -e '
    Promise.all(["health","ready"].map(async p=>{
      const r=await fetch("http://127.0.0.1:3000/"+p,{signal:AbortSignal.timeout(2000)});
      if(r.status!==200)throw Error("not ready");
    })).then(()=>process.exit(0)).catch(()=>process.exit(1));
  ' >/dev/null 2>&1; then
    printf 'Application ready: health=200 ready=200 (waited %ss).\n' "$((limit + SECONDS - deadline))"
    exit 0
  fi
  remaining=$((deadline - SECONDS))
  ((remaining <= 0)) && break
  if ((remaining > 2)); then sleep 2; else sleep "$remaining"; fi
done
printf 'ERROR: app did not reach health=200 and ready=200 within %s seconds. Stop this procedure. Inspect dc ps -a and app logs locally; do not delete volumes or restore the database blindly. Use the documented application rollback if needed.\n' "$limit" >&2
exit 1
