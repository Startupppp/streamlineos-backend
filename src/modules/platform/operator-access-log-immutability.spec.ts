import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKEND_SRC = resolve(__dirname, "../..");
const REPO_ROOT = resolve(BACKEND_SRC, "..");
const MIGRATION_TAG = "1069_operator_access_log_append_only";

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

const DELETE_RE = /\.delete\s*\(\s*operatorAccessLog\b|\bdelete\b.*\bfrom\b.*\boperator_access_log\b/i;
const UPDATE_RE = /\.update\s*\(\s*operatorAccessLog\b/;
const SERVICE_FILES = walkTs(join(BACKEND_SRC, "modules")).concat(walkTs(join(BACKEND_SRC, "common")));

describe("operator_access_log immutability — code-level enforcement", () => {
  it("(bite proof) the scanner actually sees operatorAccessLog in sources — it is not vacuously quiet", () => {
    expect(SERVICE_FILES.some((f) => readFileSync(f, "utf8").includes("operatorAccessLog"))).toBe(true);
  });

  it("no service physically DELETEs a break-glass access record", () => {
    const violations = SERVICE_FILES.filter((f) => DELETE_RE.test(readFileSync(f, "utf8"))).map((f) =>
      f.replace(BACKEND_SRC, "").replace(/\\/g, "/"),
    );
    expect(violations).toEqual([]);
  });

  it("no service UPDATEs a break-glass access record — redaction goes through the SECURITY DEFINER function", () => {
    const violations = SERVICE_FILES.filter((f) => UPDATE_RE.test(readFileSync(f, "utf8"))).map((f) =>
      f.replace(BACKEND_SRC, "").replace(/\\/g, "/"),
    );
    expect(violations).toEqual([]);
  });
});

describe("operator_access_log immutability — database boundary", () => {
  const migration = readFileSync(join(REPO_ROOT, "migrations", `${MIGRATION_TAG}.sql`), "utf8");

  it("revokes the application role's mutation grants on the table", () => {
    expect(migration).toContain("REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER");
    expect(migration).toContain("ON TABLE public.operator_access_log FROM streamline_app;");
  });

  it("defines a trigger that blocks UPDATE and DELETE with a privilege error", () => {
    expect(migration).toContain("CREATE TRIGGER operator_access_log_append_only");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON public.operator_access_log");
    expect(migration).toContain("DROP TRIGGER IF EXISTS operator_access_log_append_only");
    expect(migration).toContain("RAISE EXCEPTION 'operator_access_log is append-only; % is not permitted', TG_OP");
    expect(migration).toContain("USING ERRCODE = '42501'");
    expect(migration).toContain("LANGUAGE plpgsql");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path = pg_catalog, public, app");
  });

  it("routes erasure through a tenant-scoped redaction function rather than a DELETE", () => {
    expect(migration).toContain("app.redact_operator_access_log_subject(p_operator_user_id text)");
    expect(migration).toContain("current_setting('app.organization_id', true)");
    expect(migration).toContain("set_config('app.operator_access_log_redaction', 'true', true)");
    expect(migration).toContain("ip_address = NULL");
    expect(migration).toContain("REVOKE ALL ON FUNCTION app.redact_operator_access_log_subject(text) FROM PUBLIC;");
  });

  it("the trigger's only escape is the redaction flag, and it is UPDATE-only", () => {
    expect(migration).toContain("IF TG_OP = 'UPDATE'");
    expect(migration).toContain("current_setting('app.operator_access_log_redaction', true) = 'true'");
  });

  it("also blocks TRUNCATE, which a row-level trigger never sees", () => {
    expect(migration).toContain("CREATE TRIGGER operator_access_log_no_truncate");
    expect(migration).toContain("BEFORE TRUNCATE ON public.operator_access_log");
    expect(migration).toContain("FOR EACH STATEMENT");
    expect(migration).toContain("DROP TRIGGER IF EXISTS operator_access_log_no_truncate");
  });

  it("is registered in the Drizzle journal — an unregistered migration never runs while db:migrate still prints success", () => {
    const journal = JSON.parse(readFileSync(join(REPO_ROOT, "migrations", "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    expect(journal.entries.filter((e) => e.tag === MIGRATION_TAG)).toHaveLength(1);

    const idxs = journal.entries.map((e) => e.idx);
    expect(new Set(idxs).size).toBe(idxs.length);

    // Registration is array position plus a file on disk, not a `when` ordering. `when` is a ledger
    // stamp: `run-pending-migrations.mjs` queues every entry in journal array order and lets the
    // file-hash guard decide what applies — the comment there records that filtering on `when` is
    // what silently skipped 32 entries. Merging two lineages interleaves their stamps, and
    // renumbering them is precisely what check-migration-immutability.mjs reports as a broken seal.
    expect(existsSync(join(REPO_ROOT, "migrations", `${MIGRATION_TAG}.sql`))).toBe(true);
  });

  it("ships a rollback that names the risk it reintroduces", () => {
    const rollback = readFileSync(join(REPO_ROOT, "migrations", "rollback", `${MIGRATION_TAG}.down.sql`), "utf8");
    expect(rollback).toContain("DROP TRIGGER IF EXISTS operator_access_log_append_only");
    expect(rollback).toContain("database-level mutation guard");
    expect(rollback).toContain("release authority's compensating control");
  });

  it("the live verifier checks this trail too, not only audit_logs", () => {
    const verifier = readFileSync(join(BACKEND_SRC, "scripts", "verify-audit-log-privileges.mjs"), "utf8");
    expect(verifier).toContain("'operator_access_log', 'operator_access_log_append_only', 'prevent_operator_access_log_mutation'");
    expect(verifier).toContain("(t.tgtype::integer & 16) <> 0");
    expect(verifier).toContain("(t.tgtype::integer & 8) <> 0");
    expect(verifier).toContain("expected 2");
  });
});

describe("operator_access_log immutability — migration 1111 interaction", () => {
  const migration1111 = readFileSync(
    join(REPO_ROOT, "migrations", "1111_app_role_grants_for_ungranted_tables.sql"),
    "utf8",
  );
  const migration1069 = readFileSync(
    join(REPO_ROOT, "migrations", "1069_operator_access_log_append_only.sql"),
    "utf8",
  );

  it("migration 1111 regrants UPDATE and DELETE on operator_access_log — trigger from 1069 is the sole db-level guard after this", () => {
    expect(migration1111).toContain('"operator_access_log"');
    expect(migration1111).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON "operator_access_log"/);
  });

  it("(bite proof) migration 1111 does NOT drop the append-only trigger installed by migration 1069", () => {
    expect(migration1111).not.toContain("DROP TRIGGER operator_access_log_append_only");
    expect(migration1111).not.toContain("DROP TRIGGER IF EXISTS operator_access_log_append_only");
    expect(migration1111).not.toContain("DROP TRIGGER operator_access_log_no_truncate");
    expect(migration1111).not.toContain("DROP TRIGGER IF EXISTS operator_access_log_no_truncate");
  });

  it("(bite proof) migration 1111 does NOT grant TRUNCATE on operator_access_log — TRUNCATE stays privilege-blocked and trigger-blocked", () => {
    const oacBlock = migration1111.match(/operator_access_log[^;]*/g) ?? [];
    for (const block of oacBlock)
      expect(block).not.toContain("TRUNCATE");
  });

  it("migration 1111 ALTER DEFAULT PRIVILEGES covers future tables — append-only future tables need their own triggers since privilege revoke alone is not durable", () => {
    expect(migration1111).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE");
    expect(migration1111).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO streamline_app");
  });

  it("(bite proof) the 1069 trigger blocks UPDATE whether or not the grant exists — the trigger fires before the operation", () => {
    expect(migration1069).toContain("BEFORE UPDATE OR DELETE ON public.operator_access_log");
    expect(migration1069).toContain("RAISE EXCEPTION 'operator_access_log is append-only; % is not permitted', TG_OP");
    expect(migration1069).toContain("USING ERRCODE = '42501'");
  });

  it("the TRUNCATE trigger from migration 1069 fires as a STATEMENT trigger — it catches TRUNCATE that the row trigger cannot see", () => {
    expect(migration1069).toContain("BEFORE TRUNCATE ON public.operator_access_log");
    expect(migration1069).toContain("FOR EACH STATEMENT");
  });

  it("migration 1111 is registered in the journal after migration 1069 — so its grant overrides 1069's REVOKE at the privilege level", () => {
    const journal = JSON.parse(
      readFileSync(join(REPO_ROOT, "migrations", "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const idx1069 = journal.entries.findIndex((e) => e.tag === "1069_operator_access_log_append_only");
    const idx1111 = journal.entries.findIndex((e) => e.tag === "1111_app_role_grants_for_ungranted_tables");
    expect(idx1069).toBeGreaterThan(-1);
    expect(idx1111).toBeGreaterThan(-1);
    expect(idx1111).toBeGreaterThan(idx1069);
  });
});

describe("operator_access_log immutability — migration 1112 restores the privilege boundary", () => {
  const TAG_1112 = "1112_operator_access_log_restore_append_only_privileges";
  const migration1112 = readFileSync(join(REPO_ROOT, "migrations", `${TAG_1112}.sql`), "utf8");
  const journal = JSON.parse(
    readFileSync(join(REPO_ROOT, "migrations", "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };
  const positionOf = (tag: string) => journal.entries.findIndex((e) => e.tag === tag);

  it("revokes UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER from the application role", () => {
    expect(migration1112).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.operator_access_log FROM streamline_app/,
    );
  });

  it("leaves SELECT and INSERT alone — the service still appends and reads its own audit rows", () => {
    expect(migration1112).not.toMatch(/REVOKE[^;]*\bSELECT\b/);
    expect(migration1112).not.toMatch(/REVOKE[^;]*\bINSERT\b/);
  });

  it("sets lock_timeout and guards on to_regclass so it is safe where the table does not exist", () => {
    expect(migration1112).toContain("SET lock_timeout");
    expect(migration1112).toContain("to_regclass('public.operator_access_log')");
  });

  it("is registered in the journal AFTER 1111, or 1111's blanket grant would win on a cold build", () => {
    expect(positionOf(TAG_1112)).toBeGreaterThan(-1);
    expect(positionOf(TAG_1112)).toBeGreaterThan(positionOf("1111_app_role_grants_for_ungranted_tables"));
  });

  it("(bite proof) does not drop either append-only trigger — privilege and trigger are defence in depth, not alternatives", () => {
    expect(migration1112).not.toContain("DROP TRIGGER");
  });

  it("no later journalled migration regrants UPDATE or DELETE on operator_access_log", () => {
    const after = journal.entries.slice(positionOf(TAG_1112) + 1);
    const regranting = after.filter((entry) => {
      const file = join(REPO_ROOT, "migrations", `${entry.tag}.sql`);
      if (!existsSync(file)) return false;
      const sql = readFileSync(file, "utf8");
      return /GRANT[^;]*\b(UPDATE|DELETE)\b[^;]*operator_access_log/.test(sql);
    });
    expect(regranting.map((entry) => entry.tag)).toEqual([]);
  });
});
