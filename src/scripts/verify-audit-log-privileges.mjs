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
    updateRevoked: row.canUpdate === false,
    deleteRevoked: row.canDelete === false,
    // `triggerPresent` is deliberately narrow: an unrelated enabled trigger
    // must not be mistaken for the append-only control.
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
  const pass =
    safe.updateRevoked &&
    safe.deleteRevoked &&
    safe.triggerPresent &&
    !unsafe.updateRevoked &&
    !missingNamedTrigger.triggerPresent;
  process.stdout.write(JSON.stringify({ selfTest: true, pass, safe, unsafe }) + "\n");
  process.exit(pass ? 0 : 1);
}

const url = process.env.APP_DATABASE_URL;
if (!url) {
  process.stderr.write("APP_DATABASE_URL is required; connect as the non-owner application role\n");
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
  if (!result.updateRevoked || !result.deleteRevoked || !result.triggerPresent) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`AUDIT PRIVILEGE QUERY FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await sql.end();
}
