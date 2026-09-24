import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const BACKEND_ROOT = resolve(__dirname, "../../../..");
const MIGRATIONS_DIR = join(BACKEND_ROOT, "migrations");
const SQL_DIR = join(MIGRATIONS_DIR, "sql");
const SCRIPTS_DIR = join(BACKEND_ROOT, "src", "scripts");

const APPLIERS = [
  "db-bootstrap.mjs",
  "run-pending-migrations.mjs",
  "apply-journalled-migration.mjs",
  "replay-chain-cold.mjs",
];

const journal: { entries?: { tag?: string }[] } = JSON.parse(
  readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
);
const journalTags = new Set((journal.entries ?? []).map((e) => e.tag));
const phase2Files = readdirSync(SQL_DIR).filter((f) => f.endsWith(".sql"));

describe("the Phase 2 design SQL sits inside migrations/ without being a migration", () => {
  it("finds both a populated journal and a populated sql directory, so the exclusions below are not vacuous", () => {
    expect(journalTags.size).toBeGreaterThan(0);
    expect(phase2Files.length).toBeGreaterThan(0);
  });

  it.each(phase2Files)("%s has no journal entry, so db:migrate can never select it", (name) => {
    expect(journalTags.has(name.replace(/\.sql$/, ""))).toBe(false);
  });

  it("holds only the four Phase 2 workstreams, so an unrelated file cannot arrive here unnoticed", () => {
    for (const name of phase2Files) {
      expect(name).toMatch(/^(a-sprint-cycle|b-qa-bug|c-confdelsetcols|d-1141-1142)-/);
    }
  });

  it("keeps every journalled migration at the top level, so none of these files shadows one", () => {
    const topLevel = new Set(
      readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")),
    );
    for (const tag of journalTags) {
      expect(topLevel.has(tag === undefined ? "" : tag)).toBe(true);
    }
  });
});

describe("no migration applier can descend into a migrations subdirectory", () => {
  it.each(APPLIERS)("%s selects work from the journal rather than from a directory listing", (name) => {
    const source = readFileSync(join(SCRIPTS_DIR, name), "utf8");
    expect(source).toMatch(/_journal\.json/);
  });

  it.each(APPLIERS)("%s never reads a directory recursively", (name) => {
    const source = readFileSync(join(SCRIPTS_DIR, name), "utf8");
    expect(source).not.toMatch(/recursive\s*:\s*true/);
  });
});
