/**
 * backfill-chat-attachment-file-url.mjs
 *
 * Clears the permanent public URL stored in chat_attachments.file_url by
 * replacing it with the tenant-scoped file_key for every row where file_url
 * still contains an https:// URL.
 *
 * Background: Before the private-attachment fix, POST /storage/upload returned
 * a permanent public R2 URL, which callers forwarded as file_url when sending
 * chat messages. The API now strips file_url from all responses; this script
 * removes the stale value from the DB so it cannot be re-exposed if the column
 * is ever queried directly.
 *
 * Operator action still required:
 *   Make the R2 bucket private (remove the public-access policy). This script
 *   does NOT invalidate already-leaked URLs — objects remain accessible at
 *   their original public URLs until the bucket policy changes or the objects
 *   are moved/deleted. That is an action in the R2 / Cloudflare console.
 *
 * Safety:
 *   - Dry-run by default. Pass --apply to write changes.
 *   - Idempotent: rows where file_url does not start with "https" are skipped
 *     automatically on every run.
 *   - Resumable: the WHERE clause (file_url LIKE 'https%') naturally skips
 *     already-updated rows, so re-running after an interruption is safe.
 *   - Per-org GUC: RLS is live on chat_attachments. Each org's rows are
 *     processed inside a transaction with SET LOCAL app.organization_id so the
 *     RLS policy passes. Requires APP_DATABASE_URL (streamline_app role).
 *   - Keyset pagination: iterates by ascending id within each org; never OFFSET.
 *   - Never touches R2 objects — DB column only.
 *
 * Usage:
 *   node scripts/backfill-chat-attachment-file-url.mjs [--apply] [--url <DSN>]
 *
 * Environment:
 *   APP_DATABASE_URL — streamline_app role DSN (required; avoid the owner role
 *                      so the GUC path is exercised by the same code the app uses)
 *   DATABASE_URL     — fallback; accepted but the owner role bypasses RLS proofs
 */

import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();

const BATCH_SIZE = 500;

const args = process.argv.slice(2);
let apply = false;
let urlOverride;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--apply") { apply = true; continue; }
  if (args[i] === "--url") { urlOverride = args[++i]; continue; }
}

const dsn = urlOverride ?? process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
if (!dsn) {
  console.error("No DSN: set APP_DATABASE_URL or pass --url <DSN>");
  process.exit(1);
}

if (!apply) console.log("DRY-RUN — pass --apply to write changes\n");

const sql = postgres(dsn, { prepare: false, max: 1 });

async function processOrg(orgId) {
  let afterId = 0;
  let totalInOrg = 0;

  for (;;) {
    const batchCount = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);

      if (apply) {
        const rows = await tx`
          UPDATE chat_attachments
          SET    file_url = file_key
          WHERE  org_id   = ${orgId}
            AND  file_url LIKE 'https%'
            AND  id > ${afterId}
          ORDER BY id
          LIMIT  ${BATCH_SIZE}
          RETURNING id
        `;
        if (rows.length > 0) afterId = rows[rows.length - 1].id;
        return rows.length;
      } else {
        const rows = await tx`
          SELECT id
          FROM   chat_attachments
          WHERE  org_id   = ${orgId}
            AND  file_url LIKE 'https%'
            AND  id > ${afterId}
          ORDER BY id
          LIMIT  ${BATCH_SIZE}
        `;
        if (rows.length > 0) afterId = rows[rows.length - 1].id;
        return rows.length;
      }
    });

    totalInOrg += batchCount;
    if (batchCount < BATCH_SIZE) break;
  }

  return totalInOrg;
}

async function remainingForOrg(orgId) {
  const [row] = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.organization_id = '${orgId}'`);
    return tx`
      SELECT count(*)::int AS n
      FROM   chat_attachments
      WHERE  org_id   = ${orgId}
        AND  file_url LIKE 'https%'
    `;
  });
  return row?.n ?? 0;
}

async function main() {
  let orgs;
  try {
    orgs = await sql`SELECT id FROM organizations ORDER BY created_at`;
  } catch (err) {
    console.error("Failed to list organizations:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`Found ${orgs.length} organization(s)\n`);

  let grandTotal = 0;
  let grandRemaining = 0;

  for (const org of orgs) {
    const orgId = org.id;
    const processed = await processOrg(orgId);
    grandTotal += processed;

    if (processed > 0) {
      if (apply) {
        const remaining = await remainingForOrg(orgId);
        grandRemaining += remaining;
        console.log(`org ${orgId}: ${processed} updated, ${remaining} remaining`);
      } else {
        console.log(`org ${orgId}: ${processed} row(s) would be updated`);
        grandRemaining += processed;
      }
    }
  }

  console.log(`\nSummary: ${apply ? "updated" : "would update"} ${grandTotal} row(s)`);
  if (apply && grandRemaining > 0)
    console.log(`WARNING: ${grandRemaining} row(s) still have public URLs — re-run to continue`);
  if (!apply && grandTotal === 0)
    console.log("No rows with public URLs found — nothing to do");
  if (!apply && grandTotal > 0)
    console.log("Re-run with --apply to write changes");
}

main()
  .catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => sql.end());
