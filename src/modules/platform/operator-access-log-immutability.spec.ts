import { readFileSync, readdirSync } from "node:fs";
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

  it("is registered in the Drizzle journal — an unregistered migration never runs while db:migrate still prints success", () => {
    const journal = JSON.parse(readFileSync(join(REPO_ROOT, "migrations", "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; when: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);
    expect(entry).toBeDefined();

    const idxs = journal.entries.map((e) => e.idx);
    expect(new Set(idxs).size).toBe(idxs.length);

    const whens = journal.entries.map((e) => e.when);
    expect([...whens].sort((a, b) => a - b)).toEqual(whens);
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
