#!/usr/bin/env bash
# Second independent clean bootstrap into scratch_boot_a. Never touches neondb or cell2.
set -u
cd /d/projects/personal/Streamlineos/backend

BASE=$(node -e '
const fs=require("node:fs");
const line=fs.readFileSync(".env","utf8").split(/\r?\n/).find(l=>l.startsWith("DATABASE_URL="));
let v=line.slice("DATABASE_URL=".length).trim().replace(/^["'"'"']|["'"'"']$/g,"");
v=v.replace("-pooler","");
process.stdout.write(v);
')

TARGET=$(node -e '
const u=new URL(process.argv[1]);
u.pathname="/scratch_boot_a";
process.stdout.write(u.toString());
' "$BASE")

case "$TARGET" in
  *scratch_boot_a*) ;;
  *) echo "REFUSING: target is not scratch_boot_a"; exit 1;;
esac

echo "=== reset scratch_boot_a ==="
SCRATCH_URL="$TARGET" node src/scripts/reset-scratch-db.mjs 2>&1 | tail -12

echo "=== apply 0000 ==="
COLD_DATABASE_URL="$TARGET" node src/scripts/apply-0000-workaround.mjs 2>&1 | tail -6

echo "=== replay chain ==="
COLD_DATABASE_URL="$TARGET" node --max-old-space-size=8192 src/scripts/replay-chain-cold.mjs \
  > /tmp/replay-scratch-boot-a.log 2>&1
echo "replay exit: $?"
tail -20 /tmp/replay-scratch-boot-a.log

echo "=== DONE scratch_boot_a ==="
