#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_dir="$(cd "${1:?Usage: scripts/restore.sh BACKUP_DIR --replace}" && pwd)"
[ "${2:-}" = '--replace' ] || { echo 'Pass --replace to explicitly replace this installation with the backup.'; exit 1; }
for file in helix-data.tgz foundry-data.tgz config.env; do [ -f "$backup_dir/$file" ] || { echo "Missing $file"; exit 1; }; done
for file in helix-data.tgz foundry-data.tgz; do
  docker run --rm -v "$backup_dir:/backup:ro" alpine:3.22 tar tzf "/backup/$file" >/dev/null || { echo "Backup archive $file is unreadable or corrupt; nothing was changed."; exit 1; }
done
grep -Eq '^ENCRYPTION_KEY=.{32,}$' "$backup_dir/config.env" && grep -Eq '^INTERNAL_KEY=.{32,}$' "$backup_dir/config.env" || { echo "config.env is missing a valid ENCRYPTION_KEY or INTERNAL_KEY; nothing was changed."; exit 1; }
docker compose stop app worker executor helix
project_name="${COMPOSE_PROJECT_NAME:-helix-foundry}"
for volume in helix-data foundry-data; do
  docker run --rm -v "${project_name}_$volume:/data" -v "$backup_dir:/backup:ro" alpine:3.22 sh -c 'set -e; rm -rf /data/.restore-staging; mkdir /data/.restore-staging; tar xzf "/backup/$1.tgz" -C /data/.restore-staging; find /data -mindepth 1 -maxdepth 1 ! -name .restore-staging -exec rm -rf {} +; cd /data/.restore-staging; find . -mindepth 1 -maxdepth 1 -exec mv {} /data/ \; ; cd /; rmdir /data/.restore-staging' sh "$volume"
done
cp "$backup_dir/config.env" .env
chmod 600 .env
docker compose up -d helix executor app worker
