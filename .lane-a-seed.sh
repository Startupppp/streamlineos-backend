#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
set -a; . ./.env; set +a
API="https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID"
OWNER=$(curl -s -H "Authorization: Bearer $NEON_API_KEY" "$API/connection_uri?branch_id=br-sparkling-block-az4pth1h&database_name=scratch_e2e&role_name=neondb_owner" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).uri||'')}catch(e){process.stdout.write('')}})")
DIRECT=$(printf '%s' "$OWNER" | sed 's/-pooler\./\./')
SCRATCH_DATABASE_URL="$DIRECT" node src/scripts/seed-scratch-e2e.mjs --purge
echo "SEED_EXIT=$?"
DATABASE_URL="$DIRECT" node -e "
const p=require('postgres');const s=p(process.env.DATABASE_URL,{ssl:'require',max:1,prepare:false});
(async()=>{try{for(const t of ['organizations','users','organization_members','org_modules','organization_placement','leave_requests','attendance','helpdesk_tickets','announcements','mail_message_metadata'])
{const r=await s.unsafe('select count(*)::int c from '+t).catch(e=>[{c:'ERR '+e.code}]);console.log(t.padEnd(26),r[0].c);}}finally{await s.end()}})()"
echo "=== SEED_LANE_DONE ==="
