#!/usr/bin/env bash
PROBE=$(node scripts/probe-url.tmp.mjs 2>/dev/null | tail -1)
prev=0
for attempt in $(seq 1 40); do
  node scripts/db-query.mjs --url "$PROBE" \
    "select pg_terminate_backend(pid) from pg_stat_activity where datname='migrate_probe_s2' and pid <> pg_backend_pid() and state='idle'" >/dev/null 2>&1
  DATABASE_URL="$PROBE" timeout 150 node scripts/apply-pending-migrations.mjs --tolerate-exists >> /tmp/loop.txt 2>&1
  now=$(node scripts/db-query.mjs --url "$PROBE" "select count(*)::int a from drizzle.__drizzle_migrations" 2>/dev/null | grep -oE '"a": [0-9]+' | grep -oE '[0-9]+')
  echo "attempt=$attempt applied=$now"
  if [ "$now" = "$prev" ]; then echo "NO PROGRESS"; break; fi
  prev="$now"
done
