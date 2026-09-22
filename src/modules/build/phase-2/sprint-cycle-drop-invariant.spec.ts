import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const BACKEND_SRC = join(__dirname, "..", "..", "..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_SRC, rel), "utf8");
}

function scanDir(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full, results);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      results.push(full);
    }
  }
  return results;
}

const MIGRATION_PATTERN = /[/\\]migrations[/\\]/;

function isApplicationSource(filePath: string): boolean {
  return !MIGRATION_PATTERN.test(filePath);
}

const QUERY_BUILDER_FORM = /\b(?:from|insert|update|delete)\(\s*sprints\s*[),]/;
// The lookbehind is load-bearing: without it `this.sprints.listSprints` and the module
// specifier `"./sprints.service"` both read as table access, and the scanner reports
// violators that never touch the table.
const COLUMN_ACCESS_FORM = /(?<![.\w/"'])sprints\.[a-zA-Z_$][\w$]*/;
const RELATION_FORM = /relations\(\s*sprints\s*[,)]/;
// Tolerates CRLF: a literal "\n" in a needle silently never matches a Windows checkout,
// which is how a declaration assertion turns vacuous and passes while the table is still there.
const DECLARES_SPRINTS_TABLE = /build\.table\(\s*"sprints"/;

function touchesSprintsTable(content: string): boolean {
  return (
    QUERY_BUILDER_FORM.test(content) ||
    COLUMN_ACCESS_FORM.test(content) ||
    RELATION_FORM.test(content)
  );
}

describe("phase-05 drop invariant: the scanner is non-vacuous", () => {
  it("flags a select from the sprints table", () => {
    expect(touchesSprintsTable(".from(sprints)")).toBe(true);
  });

  it("flags an update of the sprints table", () => {
    expect(touchesSprintsTable("await tx.update(sprints).set({ deletedAt: now })")).toBe(true);
  });

  it("flags a bare column reference, which survives when the query-builder call is on another line", () => {
    expect(touchesSprintsTable("eq(sprints.orgId, orgId)")).toBe(true);
  });

  it("flags a Drizzle relation declared on the table, which is how db.query.sprints comes into existence", () => {
    expect(touchesSprintsTable("export const sprintsRelations = relations(sprints, ({ one }) => ({")).toBe(true);
  });

  it("does not fire on the cycles table that replaces it", () => {
    expect(touchesSprintsTable(".from(cycles)")).toBe(false);
    expect(touchesSprintsTable("eq(cycles.orgId, orgId)")).toBe(false);
  });

  it("does not fire on the cycleScopeEvents table, which phase 06 renames rather than drops", () => {
    expect(touchesSprintsTable(".from(cycleScopeEvents)")).toBe(false);
    expect(touchesSprintsTable("eq(cycleScopeEvents.orgId, orgId)")).toBe(false);
  });

  it("does not fire on an injected service property named sprints, which is a method call and not a table read", () => {
    expect(touchesSprintsTable("return this.sprints.listSprints(u.orgId, projectId);")).toBe(false);
  });

  it("does not fire on the sprints.service module specifier, which is a file path and not a table read", () => {
    expect(touchesSprintsTable('import { SprintsService } from "./sprints.service";')).toBe(false);
  });

  it("does not fire on the build:sprints:view permission key, which outlives the table by design", () => {
    expect(touchesSprintsTable('cycle: "build:sprints:view",')).toBe(false);
  });

  it("the table-declaration matcher matches the declaration as written, across both line endings", () => {
    expect(DECLARES_SPRINTS_TABLE.test('export const sprints = build.table(\r\n  "sprints",')).toBe(true);
    expect(DECLARES_SPRINTS_TABLE.test('export const sprints = build.table(\n  "sprints",')).toBe(true);
    expect(DECLARES_SPRINTS_TABLE.test('export const cycles = build.table(\r\n  "cycles",')).toBe(false);
  });
});

describe("phase-05 drop invariant: nothing outside migrations touches build.sprints", () => {
  it("no non-spec source reads, writes or declares a relation on the sprints table — the precondition a-sprint-cycle-05-drop.sql has no guard for", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);
    expect(allFiles.length).toBeGreaterThan(50);

    const violators = allFiles
      .filter((f) => touchesSprintsTable(readFileSync(f, "utf8")))
      .map((f) => relative(BACKEND_SRC, f))
      .sort();

    expect(violators).toEqual([]);
  });

  it("no non-spec source imports the sprints table binding, so a future edit cannot reach it without first re-adding the import", () => {
    const allFiles = scanDir(BACKEND_SRC).filter(isApplicationSource);

    const importers = allFiles
      .filter((f) => /^\s*sprints,\s*$/m.test(readFileSync(f, "utf8")))
      .map((f) => relative(BACKEND_SRC, f))
      .sort();

    expect(importers).toEqual([]);
  });
});

describe("phase-05 drop invariant: the schema no longer declares the dropped table", () => {
  it("build/core.ts does not declare the sprints table, so no relation or foreign key can reference it after the drop", () => {
    const core = src("db/schema/build/core.ts");
    expect(core.length).toBeGreaterThan(500);
    expect(DECLARES_SPRINTS_TABLE.test(core)).toBe(false);
  });

  it("cycles carries no foreign key to sprints, because DROP TABLE cannot run while a dependent constraint exists", () => {
    expect(src("db/schema/build/core.ts")).not.toContain("fk_cycles_org_legacy_sprint");
  });

  it("relations.ts declares no sprintsRelations, so db.query.sprints does not exist to be called", () => {
    const relations = src("db/schema/build/relations.ts");
    expect(relations.length).toBeGreaterThan(0);
    expect(relations).not.toContain("sprintsRelations");
  });

  it("cycles declares the goal and deleted_at columns that migration 1155 reconciled, so the iteration identity keeps both fields after the drop", () => {
    const core = src("db/schema/build/core.ts");
    const block = core.slice(
      core.indexOf("export const cycles = build.table("),
      core.indexOf("export const modules = build.table("),
    );
    expect(block.length).toBeGreaterThan(200);
    expect(block).toContain('goal: text("goal")');
    expect(block).toMatch(/deletedAt:\s*timestamp\("deleted_at"/);
  });
});
