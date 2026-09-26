import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "..", "..");

const WRITER_ALLOWLIST = [
  join("common", "hr", "sync-canonical-reporting-line.ts"),
  join("db", "schema", "hr", "core-people.ts"),
  join("db", "schema", "hr", "reporting-manager.ts"),
];

const SENTINEL = /effective_?[tT]o[^\n]{0,40}infinity/;

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, found);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("reporting line effective-date rule", () => {
  const files = walk(SRC);

  it("scans enough files that a broken scan cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(2000);
  });

  it("proves the scan detects the sentinel it is looking for", () => {
    expect(SENTINEL.test("AND rl.effective_to = 'infinity'::date")).toBe(true);
    expect(SENTINEL.test("sql`${hrReportingLines.effectiveTo} = 'infinity'::date`")).toBe(true);
    expect(SENTINEL.test("rl.effective_to >= CURRENT_DATE")).toBe(false);
  });

  it("reads the current reporting line by date bounds, never by the infinity sentinel", () => {
    const offenders = files.filter((file) => {
      if (WRITER_ALLOWLIST.some((allowed) => file.endsWith(allowed))) return false;
      return SENTINEL.test(readFileSync(file, "utf8"));
    });

    expect(offenders.map((file) => file.slice(SRC.length + 1))).toEqual([]);
  });
});
