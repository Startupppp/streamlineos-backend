#!/usr/bin/env node
/* global process */

/**
 * Verify the deployed application role cannot mutate the immutable audit log.
 *
 * This deliberately connects with APP_DATABASE_URL (the application role),
 * not the owner connection. A source migration or owner-role query cannot
 * prove the privilege boundary used by the running service.
 *
 * Usage:
 *   node src/scripts/verify-audit-log-privileges.mjs
 *   node src/scripts/verify-audit-log-privileges.mjs --self-test
 */
import postgres from "postgres";

const selfTest = process.argv.includes("--self-test");

export function evaluatePrivilegeRow(row) {
  return {
    role: String(row.role),
    isAppRole: String(row.role) === "streamline_app",
    updateRevoked: row.canUpdate === false,
    deleteRevoked: row.canDelete === false,
    triggerPresent: row.triggerPresent === true,
  };
}

if (selfTest) {
  const safe = evaluatePrivilegeRow({ role: "streamline_app", canUpdate: false, canDelete: false, triggerPresent: true });
  const unsafe = evaluatePrivilegeRow({ role: "streamline_app", canUpdate: true, canDelete: false, triggerPresent: true });
  const missingNamedTrigger = evaluatePrivilegeRow({
    role: "streamline_app",
    canUpdate: false,
    canDelete: false,
    triggerPresent: false,
  });
  const wrongRole = evaluatePrivilegeRow({
    role: "neon_superuser",
    canUpdate: false,
    canDelete: false,
    triggerPresent: true,
  });
  const pass =
    safe.isAppRole &&
    safe.updateRevoked &&
    safe.deleteRevoked &&
    safe.triggerPresent &&
    !unsafe.updateRevoked &&
    !missingNamedTrigger.triggerPresent &&
    !wrongRole.isAppRole;
  process.stdout.write(JSON.stringify({ selfTest: true, pass, safe, unsafe, wrongRole }) + "\n");
  process.exit(pass ? 0 : 1);
}

const url = process.env.APP_DATABASE_URL;
if (!url) {
  // Exit 2 is this repository's "could not determine", never "failed". A harness that
  // reads the exit code alone cannot tell the two apart, so the PREREQUISITE is named
  // in the output as well: a gate whose target was absent must not be recorded as a
  // defect, and must not be recorded as a pass either.
  process.stderr.write(
    "PREREQUISITE UNMET — cannot determine. This gate requires a live database and a\n" +
      "non-owner connection; the owner role has BYPASSRLS and would report a boundary\n" +
      "the running service does not have. Nothing about audit-log privileges was measured.\n" +
      "Required variable: APP_DATABASE_URL\n" +
      "Example: APP_DATABASE_URL=postgres://streamline_app:<password>@<host>/<database>\n",
  );
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  const rows = await sql`
    SELECT
      current_user AS role,
      has_table_privilege(current_user, 'public.audit_logs', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'public.audit_logs', 'DELETE') AS can_delete,
      EXISTS (
        SELECT 1
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace fn ON fn.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'audit_logs'
          AND t.tgname = 'audit_logs_append_only'
          AND NOT t.tgisinternal
          AND t.tgenabled <> 'D'
          AND fn.nspname = 'app'
          AND p.proname = 'prevent_audit_log_mutation'
          AND (t.tgtype::integer & 16) <> 0
          AND (t.tgtype::integer & 8) <> 0
      ) AS trigger_present
  `;
  const row = rows[0];
  if (!row) throw new Error("audit privilege query returned no row");
  const result = evaluatePrivilegeRow({
    role: row.role,
    canUpdate: row.can_update,
    canDelete: row.can_delete,
    triggerPresent: row.trigger_present,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.isAppRole || !result.updateRevoked || !result.deleteRevoked || !result.triggerPresent) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`AUDIT PRIVILEGE QUERY FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await sql.end();
}
