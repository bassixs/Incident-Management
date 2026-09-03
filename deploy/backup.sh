#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

PROJECT_DIR="${PROJECT_DIR:-/opt/incident-bot}"
BACKUP_ROOT="${BACKUP_ROOT:-$PROJECT_DIR/backups}"
DAILY_RETENTION_DAYS="${DAILY_RETENTION_DAYS:-14}"
WEEKLY_RETENTION_DAYS="${WEEKLY_RETENTION_DAYS:-70}"
MONTHLY_RETENTION_DAYS="${MONTHLY_RETENTION_DAYS:-90}"

fail() {
  printf 'backup_error=%s\n' "$1" >&2
  exit 1
}

PROJECT_DIR=$(realpath -e "$PROJECT_DIR")
BACKUP_ROOT=$(realpath -m "$BACKUP_ROOT")
EXPECTED_ROOT="$PROJECT_DIR/backups"

case "$BACKUP_ROOT" in
  "$EXPECTED_ROOT"|"$EXPECTED_ROOT"/*) ;;
  *) fail "BACKUP_ROOT must stay inside $EXPECTED_ROOT" ;;
esac

for value in "$DAILY_RETENTION_DAYS" "$WEEKLY_RETENTION_DAYS" "$MONTHLY_RETENTION_DAYS"; do
  [[ "$value" =~ ^[0-9]+$ ]] || fail "retention values must be non-negative integers"
done

install -d -m 700 "$BACKUP_ROOT"
exec 9>"$BACKUP_ROOT/.backup.lock"
flock -n 9 || fail "another backup is already running"

STAMP=$(date -u +%Y%m%d-%H%M%S)
TMP_DIR="$BACKUP_ROOT/.incomplete-$STAMP-$$"
FINAL_DIR="$BACKUP_ROOT/daily-$STAMP"

cleanup() {
  if [[ -d "$TMP_DIR" && "$TMP_DIR" == "$BACKUP_ROOT"/.incomplete-* ]]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

mkdir -m 700 "$TMP_DIR"
cd "$PROJECT_DIR"

docker compose ps --status running --services | grep -qx postgres \
  || fail "PostgreSQL container is not running"
docker compose ps --status running --services | grep -qx app \
  || fail "application container is not running"

DB_USER=$(docker compose exec -T postgres sh -c 'printf "%s" "$POSTGRES_USER"')
DB_NAME=$(docker compose exec -T postgres sh -c 'printf "%s" "$POSTGRES_DB"')
[[ -n "$DB_USER" && -n "$DB_NAME" ]] || fail "database identity is unavailable"

docker compose exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$TMP_DIR/incident.dump"

docker compose exec -T app \
  tar -C /app/data/uploads -czf - . > "$TMP_DIR/uploads.tar.gz"

install -m 600 docker-compose.yml "$TMP_DIR/docker-compose.yml"
install -m 600 .env "$TMP_DIR/.env"

cat > "$TMP_DIR/BACKUP_INFO" <<EOF
created_utc=$STAMP
hostname=$(hostname)
database=$DB_NAME
database_user=$DB_USER
EOF
chmod 600 "$TMP_DIR/BACKUP_INFO"

cd "$TMP_DIR"
sha256sum incident.dump uploads.tar.gz docker-compose.yml .env BACKUP_INFO > SHA256SUMS
chmod 600 SHA256SUMS
sha256sum -c SHA256SUMS

cd "$PROJECT_DIR"
docker compose exec -T postgres pg_restore --list < "$TMP_DIR/incident.dump" >/dev/null
tar -tzf "$TMP_DIR/uploads.tar.gz" >/dev/null

mv "$TMP_DIR" "$FINAL_DIR"
trap - EXIT
ln -sfn "$(basename "$FINAL_DIR")" "$BACKUP_ROOT/latest"

DAY_OF_WEEK=$(date -u +%u)
DAY_OF_MONTH=$(date -u +%d)

if [[ "$DAY_OF_WEEK" == 7 ]]; then
  WEEKLY_DIR="$BACKUP_ROOT/weekly-$(date -u +%G-W%V)"
  [[ -e "$WEEKLY_DIR" ]] || cp -al -- "$FINAL_DIR" "$WEEKLY_DIR"
fi

if [[ "$DAY_OF_MONTH" == 01 ]]; then
  MONTHLY_DIR="$BACKUP_ROOT/monthly-$(date -u +%Y-%m)"
  [[ -e "$MONTHLY_DIR" ]] || cp -al -- "$FINAL_DIR" "$MONTHLY_DIR"
fi

prune() {
  local prefix="$1"
  local days="$2"
  local candidate

  while IFS= read -r -d '' candidate; do
    [[ "$candidate" == "$BACKUP_ROOT/$prefix"* ]] \
      || fail "refusing to remove unexpected path: $candidate"
    rm -rf -- "$candidate"
  done < <(
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
      -name "$prefix*" -mtime "+$days" -print0
  )
}

prune daily- "$DAILY_RETENTION_DAYS"
prune weekly- "$WEEKLY_RETENTION_DAYS"
prune monthly- "$MONTHLY_RETENTION_DAYS"

printf 'backup_created=%s\n' "$FINAL_DIR"
printf 'backup_bytes=%s\n' "$(du -sb "$FINAL_DIR" | cut -f 1)"
