import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PRD-C140, PRD-C142, pinned against the committed capture rather than a fixture.
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
  reason?: string;
}
interface Benchmark {
  id: string;
  statementClass?: string;
  ceilingMs?: number;
  measurements?: Record<string, Observation>;
  repetitions?: number;
  warmState?: string;
  errorRate?: number;
}
interface Module {
  id: string;
  title?: string;
  surface?: string;
  tables?: unknown;
  dataset?: Record<string, { tenantRows?: number }>;
  concurrency?: { runs?: unknown[] };
  benchmarks: Benchmark[];
}
interface Manifest {
  prd: { statementCeilingsMs: { ordinary: number; complex: number } };
  environment: {
    releaseSha?: string;
    machine?: { cpuCount?: number; totalMemoryMb?: number };
    container?: unknown;
    database?: { name?: string };
    role?: { bypassrls?: boolean };
  };
  method?: {
    command?: string;
    reproduce?: string;
    samples?: number;
    replicates?: number;
    concurrencyLevels?: number[];
  };
  regressionPolicy?: unknown;
  modules: Module[];
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

describe("PRD-C140 — manifest provenance and schema completeness", () => {
  it("records the release SHA so a stale capture is identifiable", () => {
    expect(typeof manifest.environment.releaseSha).toBe("string");
    expect(manifest.environment.releaseSha!.length).toBeGreaterThanOrEqual(8);
  });

  it("records machine limits so result portability can be assessed", () => {
    expect(typeof manifest.environment.machine?.cpuCount).toBe("number");
    expect(typeof manifest.environment.machine?.totalMemoryMb).toBe("number");
  });

  it("records container info so CI vs laptop divergence is detectable", () => {
    expect(manifest.environment.container).toBeDefined();
  });

  it("records the database name so the capture can be re-run on the same seed", () => {
    expect(typeof manifest.environment.database?.name).toBe("string");
    expect(manifest.environment.database!.name!.length).toBeGreaterThan(0);
  });

  it("records the measurement role and confirms it is NOT bypassrls", () => {
    expect(manifest.environment.role).toBeDefined();
    expect(manifest.environment.role!.bypassrls).toBe(false);
  });

  it("records the reproduce command so results can be re-generated", () => {
    expect(typeof manifest.method?.command).toBe("string");
    expect(manifest.method!.command!.length).toBeGreaterThan(0);
    expect(typeof manifest.method?.reproduce).toBe("string");
    expect(manifest.method!.reproduce!.length).toBeGreaterThan(0);
  });

  it("records sample counts so statistical weight is transparent", () => {
    expect(typeof manifest.method?.samples).toBe("number");
    expect(manifest.method!.samples!).toBeGreaterThanOrEqual(1);
    expect(typeof manifest.method?.replicates).toBe("number");
    expect(manifest.method!.replicates!).toBeGreaterThanOrEqual(1);
  });

  it("records the regression policy so the noise envelope is inspectable", () => {
    expect(manifest.regressionPolicy).toBeDefined();
  });

  it("requires every non-reference benchmark to carry its required measurement fields", () => {
    const missing: string[] = [];
    for (const mod of manifest.modules) {
      for (const b of mod.benchmarks) {
        if (b.statementClass === "reference") continue;
        if (typeof b.repetitions !== "number") missing.push(`${b.id}: missing repetitions`);
        if (typeof b.warmState !== "string") missing.push(`${b.id}: missing warmState`);
        if (typeof b.errorRate !== "number") missing.push(`${b.id}: missing errorRate`);
        if (!b.measurements) missing.push(`${b.id}: missing measurements`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("records the dataset size for every module on every tenant so empty-corpus is detectable", () => {
    const absent: string[] = [];
    for (const mod of manifest.modules) {
      if (!mod.dataset) {
        absent.push(`${mod.id}: no dataset`);
        continue;
      }
      for (const tenant of TENANTS) {
        if (!mod.dataset[tenant]) absent.push(`${mod.id}@${tenant}: missing dataset entry`);
      }
    }
    expect(absent).toEqual([]);
  });
});

describe("PRD-C142 — statement ceilings on the production-shaped seed", () => {
  it("declares the PRD's two ceilings and nothing looser", () => {
    expect(manifest.prd.statementCeilingsMs).toEqual({ ordinary: 50, complex: 200 });
  });

  it("measures every slot the seed supports and accounts for every slot it does not", () => {
    const validSkipReasons = new Set([
      "seed-too-small",
      "no fixture data for this budget",
      "vacuous",
    ]);

    const gaps = slots().filter(
      (s) => s.obs.status === "unmeasured" && !validSkipReasons.has(s.obs.reason ?? ""),
    );
    expect(
      gaps.map((s) => `${s.id}@${s.tenant}: ${String(s.obs.reason)}`),
    ).toEqual([]);

    const catalogUrl = pathToFileURL(
      join(BACKEND_ROOT, "src", "scripts", "read-cost-budgets.mjs"),
    ).href;
    const catalogIds: string[] = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { BUDGETS } from ${JSON.stringify(catalogUrl)};` +
            ` process.stdout.write(JSON.stringify(BUDGETS.map((b) => b.id)));`,
        ],
        { cwd: BACKEND_ROOT, encoding: "utf8" },
      ),
    );
    const largeSkipped = new Set(
      slots()
        .filter(
          (s) =>
            s.tenant === "large" &&
            s.obs.status === "unmeasured" &&
            validSkipReasons.has(s.obs.reason ?? ""),
        )
        .map((s) => s.id),
    );
    const expectedMinimumAtLarge = catalogIds.filter((id) => !largeSkipped.has(id)).length;
    const measuredAtLarge = measured.filter((s) => s.tenant === "large").length;
    const vacuousAtLarge = slots().filter(
      (s) => s.tenant === "large" && s.obs.status === "vacuous",
    ).length;
    expect(measuredAtLarge + vacuousAtLarge).toBeGreaterThanOrEqual(expectedMinimumAtLarge);
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
    const catalogUrl = pathToFileURL(
      join(BACKEND_ROOT, "src", "scripts", "read-cost-budgets.mjs"),
    ).href;
    const ids: string[] = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { BUDGETS } from ${JSON.stringify(catalogUrl)};` +
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
