/**
 * Regression cover for PRD-C057's inventory validator, driven through the real
 * gate binary rather than its internals — the gate is an .mjs and jest's
 * transform does not reach it, and an assertion against a re-implementation of
 * the rules would prove nothing about the rules that run.
 *
 * The defect class is an inventory that READS complete. The prior wave shipped
 * one: registry-level instead of per-entry, owners missing on most rows, and
 * stale against the gate it quoted within a day — and nothing in the document
 * itself said so. Every case below is one of the ways that artifact was wrong.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE = resolve(__dirname, "../check-key-inventory.mjs");


interface Row {
  registry: string;
  item: string;
  owner: string;
  verdict: string;
  failurePrevented: string;
  evidence: string;
}

function run(args: readonly string[]): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [GATE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, output };
  } catch (error: unknown) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function loadRules(): { REQUIRED_REGISTRIES: string[]; FLOORS: Record<string, number>; VERDICTS: string[] } {
  return JSON.parse(run(["--rules"]).output) as { REQUIRED_REGISTRIES: string[]; FLOORS: Record<string, number>; VERDICTS: string[] };
}

function writeInventory(rows: readonly Row[]): string {
  const directory = mkdtempSync(join(tmpdir(), "key-inventory-"));
  mkdirSync(directory, { recursive: true });
  const byRegistry = new Map<string, Row[]>();
  for (const row of rows) {
    const bucket = byRegistry.get(row.registry);
    if (bucket === undefined) byRegistry.set(row.registry, [row]);
    else bucket.push(row);
  }
  for (const [registry, bucket] of byRegistry)
    writeFileSync(join(directory, `${registry.replace(/\./g, "-")}.jsonl`), `${bucket.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return directory;
}

function completeInventory(): Row[] {
  const { REQUIRED_REGISTRIES, FLOORS } = loadRules();
  const rows: Row[] = [];
  for (const registry of REQUIRED_REGISTRIES) {
    const floor = FLOORS[registry] ?? 1;
    for (let i = 0; i < floor; i += 1)
      rows.push({
        registry,
        item: `${registry}#${String(i)}`,
        owner: "an owning area",
        verdict: "KEEP",
        failurePrevented: "A concrete statement of the failure this entry prevents, long enough to be a real sentence.",
        evidence: "pg_catalog: something specific",
      });
  }
  return rows;
}

describe("key-inventory validation", () => {
  it("its own self-test passes, so the rules are exercised in both directions", () => {
    const result = run(["--self-test"]);
    expect(result.output).toContain("0 failed");
    expect(result.status).toBe(0);
  });

  it("names every registry PRD-C057 lists", () => {
    const { REQUIRED_REGISTRIES } = loadRules();
    for (const registry of [
      "database.column",
      "database.primary-key",
      "database.foreign-key",
      "database.unique",
      "database.check",
      "database.index",
      "database.jsonb-key",
      "code.route",
      "code.permission",
      "code.module",
      "code.event",
      "code.command",
      "code.query-key",
      "code.cache-namespace",
      "code.environment-variable",
      "code.configuration",
      "code.feature-flag",
      "code.translation",
    ])
      expect(REQUIRED_REGISTRIES).toContain(registry);
  });

  it("passes a complete, fully classified inventory", () => {
    const result = run([`--dir=${writeInventory(completeInventory())}`]);
    expect(result.status).toBe(0);
  });

  it("fails when a registry the criterion names is absent", () => {
    const rows = completeInventory().filter((row) => row.registry !== "code.event");
    const result = run([`--dir=${writeInventory(rows)}`]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("missing-registry");
  });

  it("fails a near-empty population instead of reporting a clean scan", () => {
    const rows = completeInventory().filter((row) => row.registry !== "database.column" || row.item.endsWith("#0"));
    const result = run([`--dir=${writeInventory(rows)}`]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("below-floor");
  });

  it("fails an entry with no verdict, no owner, no failure prevented or no evidence", () => {
    const cases: [Partial<Row>, string][] = [
      [{ verdict: "TBD" }, "unclassified"],
      [{ owner: "  " }, "no-owner"],
      [{ failurePrevented: "unused" }, "no-failure-prevented"],
      [{ evidence: "" }, "no-evidence"],
    ];
    for (const [mutation, expected] of cases) {
      const rows = completeInventory().map((row, index) => (index === 0 ? { ...row, ...mutation } : row));
      const result = run([`--dir=${writeInventory(rows)}`]);
      expect(result.status).toBe(1);
      expect(result.output).toContain(expected);
    }
  });

  it("is INCONCLUSIVE, never a pass, when the inventory is absent or empty", () => {
    const missing = run([`--dir=${join(tmpdir(), "no-such-inventory-directory")}`]);
    expect(missing.status).toBe(2);
    const empty = run([`--dir=${mkdtempSync(join(tmpdir(), "empty-inventory-"))}`]);
    expect(empty.status).toBe(2);
  });
});
