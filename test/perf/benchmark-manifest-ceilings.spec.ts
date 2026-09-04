import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * PRD-C142, pinned against the committed capture rather than against a fixture.
 *
 * `check-benchmark-manifest.mjs` already refuses a manifest whose statements are over ceiling, but
 * its exit code is shared with the request-level half, so a statement regression can hide behind a
 * request-level breach that is already red for another reason. These assertions read only the
 * statement half, over the WHOLE corpus, so a regression in it fails on its own.
 *
 * The corpus assertion is the one that matters most. Narrowing the measured set is a way to make
 * every remaining statement pass, so the manifest is required to carry an entry for every read-cost
 * budget the catalog declares — a budget added to `read-cost-budgets.mjs` and left unclaimed by any
 * module used to disappear from here silently.
 */

const BACKEND_ROOT = join(__dirname, "..", "..");
const MANIFEST_PATH = join(BACKEND_ROOT, "contracts", "benchmark-manifest.json");
const PLAN_DIR = join(BACKEND_ROOT, "test", "perf", "benchmark-plans");
const TENANTS = ["large", "mid", "small", "tiny"] as const;

interface Observation {
  status?: string;
  p95Ms?: number | null;
}
interface Benchmark {
  id: string;
  statementClass?: string;
  ceilingMs?: number;
  measurements?: Record<string, Observation>;
}
interface Manifest {
  prd: { statementCeilingsMs: { ordinary: number; complex: number } };
  modules: { id: string; benchmarks: Benchmark[]; readCostBudgets?: Record<string, unknown> }[];
}

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

function slots(): { id: string; tenant: string; cls: string; ceiling: number; obs: Observation }[] {
  const out: { id: string; tenant: string; cls: string; ceiling: number; obs: Observation }[] = [];
  for (const mod of manifest.modules)
    for (const b of mod.benchmarks) {
      if (b.statementClass === "reference") continue;
      for (const [tenant, obs] of Object.entries(b.measurements ?? {}))
        out.push({ id: b.id, tenant, cls: b.statementClass ?? "?", ceiling: b.ceilingMs ?? -1, obs });
    }
  return out;
}

const measured = slots().filter((s) => s.obs.status === "measured" && typeof s.obs.p95Ms === "number");

describe("PRD-C142 — statement ceilings on the production-shaped seed", () => {
  it("declares the PRD's two ceilings and nothing looser", () => {
    expect(manifest.prd.statementCeilingsMs).toEqual({ ordinary: 50, complex: 200 });
  });

  it("measures a real corpus, so an empty capture cannot read as a pass", () => {
    expect(measured.length).toBeGreaterThanOrEqual(150);
  });

  it("holds every measured ORDINARY statement at p95 <= 50 ms", () => {
    const over = measured
      .filter((s) => s.cls === "ordinary" && (s.obs.p95Ms as number) > 50)
      .map((s) => `${s.id}@${s.tenant} ${String(s.obs.p95Ms)}ms`);
    expect(over).toEqual([]);
  });

  it("holds every measured APPROVED-COMPLEX statement at p95 <= 200 ms", () => {
    const over = measured
      .filter((s) => s.cls === "complex" && (s.obs.p95Ms as number) > 200)
      .map((s) => `${s.id}@${s.tenant} ${String(s.obs.p95Ms)}ms`);
    expect(over).toEqual([]);
  });

  it("carries each statement's own declared ceiling, so the class and the number cannot disagree", () => {
    const wrong = measured
      .filter((s) => s.ceiling !== (s.cls === "complex" ? 200 : 50))
      .map((s) => `${s.id}@${s.tenant} class=${s.cls} ceiling=${String(s.ceiling)}`);
    expect(wrong).toEqual([]);
  });

  it("records no vacuous measurement, because a zero-row query satisfies every ceiling trivially", () => {
    const vacuous = slots()
      .filter((s) => s.obs.status === "vacuous")
      .map((s) => `${s.id}@${s.tenant}`);
    expect(vacuous).toEqual([]);
  });

  it("retains a plan for every measured statement that claims the 200 ms exception", () => {
    const retained = new Map<string, Set<string>>();
    for (const tenant of TENANTS) {
      const txt = readFileSync(join(PLAN_DIR, `approved-complex-${tenant}.txt`), "utf8");
      retained.set(
        tenant,
        new Set([...txt.matchAll(/^### (\S+)\s+\(approved complex/gm)].map((x) => x[1] as string)),
      );
    }
    const unretained = measured
      .filter((s) => s.cls === "complex" && !retained.get(s.tenant)?.has(s.id))
      .map((s) => `${s.id}@${s.tenant}`);
    expect(unretained).toEqual([]);
  });

  it("covers every read-cost budget the catalog declares, so the corpus cannot be narrowed", () => {
    /* ts-jest cannot `import()` the ESM catalog, so it is read out of a child node process. */
    const ids: string[] = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { BUDGETS } from ${JSON.stringify(join(BACKEND_ROOT, "src", "scripts", "read-cost-budgets.mjs"))};` +
            ` process.stdout.write(JSON.stringify(BUDGETS.map((b) => b.id)));`,
        ],
        { cwd: BACKEND_ROOT, encoding: "utf8" },
      ),
    );
    expect(ids.length).toBeGreaterThanOrEqual(70);
    const inManifest = new Set(manifest.modules.flatMap((m) => m.benchmarks.map((b) => b.id)));
    expect(ids.filter((id) => !inManifest.has(id))).toEqual([]);
  });
});
