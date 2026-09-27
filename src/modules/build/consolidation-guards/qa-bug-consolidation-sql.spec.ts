import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const ROLLBACK_DIR = join(REPO_ROOT, "migrations", "rollback");

type FileEntry = { label: string; path: string };

const expandForward: FileEntry = {
  label: "1393_build_qa_bug_tables.sql",
  path: join(MIGRATIONS_DIR, "1393_build_qa_bug_tables.sql"),
};
const expandRollback: FileEntry = {
  label: "1393_build_qa_bug_tables.down.sql",
  path: join(ROLLBACK_DIR, "1393_build_qa_bug_tables.down.sql"),
};

const ALL_FILES: FileEntry[] = [expandForward, expandRollback];

function readSql(entry: FileEntry): string {
  return readFileSync(entry.path, "utf8").replace(/\r\n/g, "\n");
}

function stripSqlComments(sql: string): string {
  const marker = "__BREAKPOINT__";
  return sql
    .split("--> statement-breakpoint")
    .join(marker)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(marker)
    .join("--> statement-breakpoint");
}

function statements(entry: FileEntry): string[] {
  return readSql(entry).split("--> statement-breakpoint");
}

describe("the QA bug consolidation SQL obeys the migration discipline gate", () => {
  it.each(ALL_FILES)("$label exists", (entry) => {
    expect(existsSync(entry.path)).toBe(true);
  });

  it.each(ALL_FILES)("$label sets lock_timeout", (entry) => {
    expect(/set\s+lock_timeout/i.test(readSql(entry))).toBe(true);
  });

  it.each(ALL_FILES)("$label adds no foreign key without NOT VALID", (entry) => {
    for (const stmt of statements(entry)) {
      if (/ADD\s+CONSTRAINT\s+\S+\s+FOREIGN\s+KEY/i.test(stmt)) {
        expect(/NOT\s+VALID/i.test(stmt)).toBe(true);
      }
    }
  });

  it.each(ALL_FILES)("$label puts no statement-breakpoint inside a DO block", (entry) => {
    for (const m of readSql(entry).matchAll(/DO\s+\$\$[\s\S]*?\$\$/gi)) {
      expect(m[0].includes("--> statement-breakpoint")).toBe(false);
    }
  });

  it.each(ALL_FILES)("$label creates no index CONCURRENTLY", (entry) => {
    expect(/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(stripSqlComments(readSql(entry)))).toBe(
      false,
    );
  });

  it.each(ALL_FILES)("$label precedes any SET NOT NULL with a CHECK IS NOT NULL NOT VALID", (entry) => {
    const sql = stripSqlComments(readSql(entry));
    if (!/ALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL/i.test(sql)) return;
    expect(/CHECK\s*\([^)]*IS\s+NOT\s+NULL[^)]*\)\s+NOT\s+VALID/i.test(sql)).toBe(true);
  });

  it.each(ALL_FILES)("$label never validates a constraint before its backfill UPDATE", (entry) => {
    const stmts = stripSqlComments(readSql(entry)).split("--> statement-breakpoint");
    const validateIdx = stmts.findIndex((s) => /VALIDATE\s+CONSTRAINT/i.test(s));
    const backfillIdx = stmts.findIndex((s) => /UPDATE\s+\S+[\s\S]*?WHERE/i.test(s));
    if (validateIdx === -1 || backfillIdx === -1) return;
    expect(validateIdx).toBeGreaterThan(backfillIdx);
  });
});

describe("no composite SET NULL key is installed in the bare form migration 1142 exists to repair", () => {
  const setNullStatements = ALL_FILES.flatMap((entry) =>
    statements(entry)
      .filter((s) => /ON\s+DELETE\s+SET\s+NULL/i.test(s))
      .map((s) => ({ label: entry.label, sql: s })),
  );

  it("finds SET NULL keys at all, so the shape assertions below are not vacuous", () => {
    expect(setNullStatements.length).toBeGreaterThan(0);
  });

  it("gives every multi-column SET NULL foreign key an explicit column list", () => {
    let composite = 0;
    for (const { sql } of setNullStatements) {
      const key = /FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(sql);
      if (!key) continue;
      if (key[1].split(",").length < 2) continue;
      composite += 1;
      expect(/ON\s+DELETE\s+SET\s+NULL\s*\(\s*"?[a-z_]+"?\s*\)/i.test(sql)).toBe(true);
    }
    expect(composite).toBeGreaterThan(0);
  });

  it("never names the tenant column in a SET NULL column list", () => {
    for (const { sql } of setNullStatements) {
      const list = /ON\s+DELETE\s+SET\s+NULL\s*\(([^)]*)\)/i.exec(sql);
      if (!list) continue;
      expect(list[1]).not.toMatch(/org_id/i);
    }
  });

  it("leaves a column list off only where the key is single-column and needs none", () => {
    let bare = 0;
    for (const { sql } of setNullStatements) {
      if (/ON\s+DELETE\s+SET\s+NULL\s*\(/i.test(sql)) continue;
      bare += 1;
      const key = /FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(sql);
      expect(key).not.toBeNull();
      expect(key === null ? [] : key[1].split(",")).toHaveLength(1);
    }
    expect(bare).toBeGreaterThan(0);
  });
});

describe("the sidecar cannot drift from the ticket it denormalises", () => {
  const expand = stripSqlComments(readSql(expandForward));

  it("creates work_item_qa_details rather than widening tickets", () => {
    expect(expand).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?build"?\."?work_item_qa_details"?/i);
  });

  it("binds the denormalised project_id through a three-column foreign key to tickets", () => {
    expect(expand).toMatch(
      /FOREIGN\s+KEY\s*\(\s*"?org_id"?\s*,\s*"?project_id"?\s*,\s*"?work_item_id"?\s*\)\s*REFERENCES\s+"?build"?\."?tickets"?\s*\(\s*"?org_id"?\s*,\s*"?project_id"?\s*,\s*"?id"?\s*\)/i,
    );
  });

  it("creates the unique index on tickets that the three-column foreign key requires", () => {
    expect(expand).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"?uniq_tickets_org_project_id"?/i);
  });

  it("creates bug_work_item_map as the permanent identity map for migrated bugs", () => {
    expect(expand).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"?build"?\."?bug_work_item_map"?/i);
  });
});
