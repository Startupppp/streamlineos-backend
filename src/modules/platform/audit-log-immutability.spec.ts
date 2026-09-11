import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKEND_SRC = resolve(__dirname, "../..");

function walkTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".spec.") && !entry.name.includes(".e2e-spec."))
      results.push(full);
  }
  return results;
}

const DELETE_RE = /\.delete\s*\(\s*auditLogs\b|\bdelete\b.*\bfrom\b.*\baudit_logs\b/i;
const UPDATE_RE = /\.update\s*\(\s*auditLogs\b/;
const SERVICE_FILES = walkTs(join(BACKEND_SRC, "modules"))
  .concat(walkTs(join(BACKEND_SRC, "common")));

describe("audit_logs immutability — code-level enforcement", () => {
  it(
    "(bite proof) scanner finds audit_logs in sources — it is not vacuously quiet",
    () => {
      const anyReference = SERVICE_FILES.some((f) =>
        readFileSync(f, "utf8").includes("auditLogs"),
      );
      expect(anyReference).toBe(true);
    },
  );

  it(
    "no service or common module physically DELETEs audit_logs rows — only the GDPR erasure script may",
    () => {
      const violations: string[] = [];
      for (const file of SERVICE_FILES) {
        const src = readFileSync(file, "utf8");
        if (DELETE_RE.test(src)) violations.push(file.replace(BACKEND_SRC, ""));
      }
      expect(violations).toEqual([]);
    },
  );

  it(
    "the only UPDATE on audit_logs is in org-purge.service.ts (nulls orgId before org deletion) — all others are violations",
    () => {
      const violations: string[] = [];
      for (const file of SERVICE_FILES) {
        const src = readFileSync(file, "utf8");
        if (!UPDATE_RE.test(src)) continue;
        const rel = file.replace(BACKEND_SRC, "").replace(/\\/g, "/");
        if (!rel.includes("org-purge.service")) violations.push(rel);
      }
      expect(violations).toEqual([]);
    },
  );
});

describe("audit_logs immutability — repository contract (not deployed evidence)", () => {
  it("records the required deployed RLS contract without claiming a live probe", () => {
    const evidence = {
      table: "audit_logs",
      relrowsecurity: true,
      policy: "tenant_isolation",
      policyCmd: "*",
      roles: "PUBLIC",
      usingClause:
        "CASE WHEN (org_id IS NULL) THEN true ELSE (org_id = current_org_id_or_null()) END",
    };
    expect(evidence.relrowsecurity).toBe(true);
    expect(evidence.policy).toBe("tenant_isolation");
  });

  it(
    "records the expected application-role privilege contract without claiming deployment",
    () => {
      const privileges = ["INSERT", "SELECT"];
      expect(privileges).not.toContain("DELETE");
      expect(privileges).not.toContain("UPDATE");
    },
  );

  it(
    "documents the migration SQL required to make audit_logs append-only for the app role",
    () => {
      const migrationRequired = [
        "REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER",
        "ON TABLE public.audit_logs FROM streamline_app;",
      ];
      const migration = readFileSync(
        join(resolve(BACKEND_SRC, ".."), "migrations/0928_organization_purge_audit_hardening.sql"),
        "utf8",
      );
      expect(migration).toContain(migrationRequired[0]);
      expect(migration).toContain(migrationRequired[1]);
      expect(migration).toContain("actor_membership_id = NULL");
      expect(migration).toContain("is_platform_event = true");
      expect(migration).toContain("current_setting('app.organization_id', true)");
    },
  );

  it("defines a database trigger that blocks UPDATE/DELETE outside purge detachment", () => {
    const migration = readFileSync(
      join(resolve(BACKEND_SRC, ".."), "migrations/0930_audit_logs_append_only_trigger.sql"),
      "utf8",
    );
    expect(migration).toContain("CREATE TRIGGER audit_logs_append_only");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON public.audit_logs");
    expect(migration).toContain("audit_log_detachment");
    expect(migration).toContain("set_config('app.audit_log_detachment', 'true', true)");
    expect(migration).toContain("RAISE EXCEPTION 'audit_logs is append-only");
    expect(migration).toContain("TG_OP = 'UPDATE'");
    expect(migration).toContain("LANGUAGE plpgsql");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public, app");
    expect(migration).toContain("RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP");
    expect(migration).toContain("DROP TRIGGER IF EXISTS audit_logs_append_only");
  });

  it("blocks TRUNCATE, which the 0930 row-level trigger never saw", () => {
    const migration = readFileSync(
      join(resolve(BACKEND_SRC, ".."), "migrations/1070_audit_logs_no_truncate.sql"),
      "utf8",
    );
    expect(migration).toContain("CREATE TRIGGER audit_logs_no_truncate");
    expect(migration).toContain("BEFORE TRUNCATE ON public.audit_logs");
    expect(migration).toContain("FOR EACH STATEMENT");
    expect(migration).toContain("app.prevent_audit_log_mutation()");
    expect(migration).toContain("DROP TRIGGER IF EXISTS audit_logs_no_truncate");
  });

  it("registers 1070 in the journal, without which it never runs", () => {
    const journal = JSON.parse(
      readFileSync(join(resolve(BACKEND_SRC, ".."), "migrations", "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const entries = journal.entries.filter((e) => e.tag === "1070_audit_logs_no_truncate");
    expect(entries).toHaveLength(1);
    const idxs = journal.entries.map((e) => e.idx);
    expect(new Set(idxs).size).toBe(idxs.length);

    // Registration is array position plus a file on disk, not a `when` ordering. `when` is a ledger
    // stamp: `run-pending-migrations.mjs` queues every entry in journal array order and lets the
    // file-hash guard decide what applies — the comment there records that filtering on `when` is
    // what silently skipped 32 entries. Merging two lineages interleaves their stamps, and
    // renumbering them is precisely what check-migration-immutability.mjs reports as a broken seal.
    expect(
      existsSync(join(resolve(BACKEND_SRC, ".."), "migrations", "1070_audit_logs_no_truncate.sql")),
    ).toBe(true);
  });

  it("keeps 1070's rollback explicit that it reopens the hole", () => {
    const rollback = readFileSync(
      join(resolve(BACKEND_SRC, ".."), "migrations/rollback/1070_audit_logs_no_truncate.down.sql"),
      "utf8",
    );
    expect(rollback).toContain("DROP TRIGGER IF EXISTS audit_logs_no_truncate");
    expect(rollback).toContain("release authority's compensating control");
  });

  it("requires the live verifier to identify the named trigger and both mutation events", () => {
    const verifier = readFileSync(
      join(resolve(BACKEND_SRC, "scripts/verify-audit-log-privileges.mjs")),
      "utf8",
    );
    expect(verifier).toContain(
      "'audit_logs', 'audit_logs_append_only', 'prevent_audit_log_mutation', 'audit_logs_no_truncate'",
    );
    expect(verifier).toContain("(t.tgtype::integer & 32) <> 0");
    expect(verifier).toContain("truncateGuardPresent");
    expect(verifier).toContain("t.tgname = target.trgname");
    expect(verifier).toContain("fn.nspname = 'app'");
    expect(verifier).toContain("p.proname = target.fnname");
    expect(verifier).toContain("t.tgenabled <> 'D'");
    expect(verifier).toContain("(t.tgtype::integer & 16) <> 0");
    expect(verifier).toContain("(t.tgtype::integer & 8) <> 0");
  });

  it("keeps the rollback artifact explicit about its compensating-control risk", () => {
    const rollback = readFileSync(
      join(resolve(BACKEND_SRC, ".."), "migrations/rollback/0930_audit_logs_append_only_trigger.down.sql"),
      "utf8",
    );
    expect(rollback).toContain("DROP TRIGGER IF EXISTS audit_logs_append_only");
    expect(rollback).toContain("database-level mutation guard");
    expect(rollback).toContain("release authority's compensating control");
    expect(rollback).toContain("current_setting('app.organization_id', true)");
  });
});
