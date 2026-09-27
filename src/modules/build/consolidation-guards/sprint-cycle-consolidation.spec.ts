import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");
const ROLLBACK_DIR = join(REPO_ROOT, "migrations", "rollback");

type FileEntry = { label: string; path: string };

const m1396Forward: FileEntry = {
  label: "1396_build_sprint_cycle_chain_repair.sql",
  path: join(MIGRATIONS_DIR, "1396_build_sprint_cycle_chain_repair.sql"),
};
const m1396Rollback: FileEntry = {
  label: "1396_build_sprint_cycle_chain_repair.down.sql",
  path: join(ROLLBACK_DIR, "1396_build_sprint_cycle_chain_repair.down.sql"),
};
const m1394Forward: FileEntry = {
  label: "1394_build_cycle_scope_events_rename.sql",
  path: join(MIGRATIONS_DIR, "1394_build_cycle_scope_events_rename.sql"),
};
const m1394Rollback: FileEntry = {
  label: "1394_build_cycle_scope_events_rename.down.sql",
  path: join(ROLLBACK_DIR, "1394_build_cycle_scope_events_rename.down.sql"),
};

const ALL_CHAIN_FILES: FileEntry[] = [m1396Forward, m1396Rollback, m1394Forward, m1394Rollback];

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8").replace(/\r\n/g, "\n");
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

describe("the consolidation SQL obeys the migration discipline gate", () => {
  it.each(ALL_CHAIN_FILES)("$label exists", (entry) => {
    expect(existsSync(entry.path)).toBe(true);
  });

  it.each(ALL_CHAIN_FILES)("$label sets lock_timeout", (entry) => {
    expect(/set\s+lock_timeout/i.test(read(entry.path))).toBe(true);
  });

  it.each(ALL_CHAIN_FILES)("$label adds no foreign key without NOT VALID", (entry) => {
    for (const stmt of read(entry.path).split("--> statement-breakpoint")) {
      if (/ADD\s+CONSTRAINT\s+\S+\s+FOREIGN\s+KEY/i.test(stmt)) {
        expect(/NOT\s+VALID/i.test(stmt)).toBe(true);
      }
    }
  });

  it.each(ALL_CHAIN_FILES)("$label puts no statement-breakpoint inside a DO block", (entry) => {
    for (const m of read(entry.path).matchAll(/DO\s+\$\$[\s\S]*?\$\$/gi)) {
      expect(m[0].includes("--> statement-breakpoint")).toBe(false);
    }
  });

  it.each(ALL_CHAIN_FILES)("$label creates no index CONCURRENTLY", (entry) => {
    const body = read(entry.path)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(body)).toBe(false);
  });

  it.each(ALL_CHAIN_FILES)("$label precedes any SET NOT NULL with a CHECK IS NOT NULL NOT VALID", (entry) => {
    const sql = read(entry.path);
    if (!/SET\s+NOT\s+NULL/i.test(sql)) return;
    expect(/CHECK\s*\([^)]*IS\s+NOT\s+NULL[^)]*\)\s+NOT\s+VALID/i.test(sql)).toBe(true);
  });

  it.each(ALL_CHAIN_FILES)("$label never validates a constraint before its backfill UPDATE", (entry) => {
    const stmts = stripSqlComments(read(entry.path)).split("--> statement-breakpoint");
    const validateIdx = stmts.findIndex((s) => /VALIDATE\s+CONSTRAINT/i.test(s));
    const backfillIdx = stmts.findIndex((s) => /UPDATE\s+\S+[\s\S]*?WHERE/i.test(s));
    if (validateIdx === -1 || backfillIdx === -1) return;
    expect(validateIdx).toBeGreaterThan(backfillIdx);
  });
});

describe("1394 is the only migration that carries the scope-events rename", () => {
  const scopeEvents = read(REPO_ROOT, "src", "db", "schema", "build", "cycle-events.ts");
  const migration1394 = read(m1394Forward.path);

  it("1396 does not carry the scope-events rename, so the chain migration and the rename are always separate journalled steps", () => {
    const migration1396 = read(m1396Forward.path);
    expect(migration1396).not.toContain("RENAME TO cycle_scope_events");
    expect(migration1396).not.toContain("RENAME TO cycle_scope_event_type");
  });

  it("1394 carries both renames and nothing else that writes data", () => {
    expect(migration1394).toContain("RENAME TO cycle_scope_events");
    expect(migration1394).toContain("RENAME TO cycle_scope_event_type");
    expect(migration1394).not.toMatch(/(INSERT|UPDATE|DELETE|DROP TABLE)/);
  });

  it("the Drizzle declaration names the post-rename table, which is the only state in which 1394 is applied and the burnup report resolves", () => {
    expect(scopeEvents).toContain('"cycle_scope_events"');
    expect(scopeEvents).toContain("buildEvents.table(");
    expect(scopeEvents).toContain('pgEnum("cycle_scope_event_type"');
    expect(scopeEvents).not.toContain('"sprint_scope_events"');
  });

  it("keeps the physical constraint and index names, because ALTER TABLE RENAME leaves them untouched and the catalog still carries the old spelling", () => {
    expect(scopeEvents).toContain('name: "fk_sprint_scope_events_org_cycle"');
    expect(scopeEvents).toContain('index("idx_sprint_scope_events_ticket")');
  });

  it("a rollback exists for 1394, because a rename is the one contraction with no overlap window", () => {
    expect(existsSync(m1394Rollback.path)).toBe(true);
  });
});
