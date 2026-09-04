/**
 * The retention half of PRD-C188 ("run retention/legal-hold drills"): does
 * `check:retention-coverage` measure anything before it reports green?
 *
 * Two independent defects made its exit 0 meaningless, and both are the kind
 * that only a database can prove:
 *
 * 1. `pg_total_relation_size(c.oid) / 1048576` is bigint division in Postgres, so
 *    every table under one mebibyte evaluated to exactly 0 MB. The gate's
 *    `--threshold-mb` flag was therefore INERT below 1: `--threshold-mb=0.1`
 *    selected the identical set as the default, because nothing could ever land
 *    between 0 and 1. A source-only assertion cannot show this — `/1048576` is
 *    perfectly ordinary JavaScript arithmetic and only Postgres rounds it — so
 *    this spec runs both divisors against the live catalogue and compares them.
 *
 * 2. Nothing put a floor under the corpus. Against a migrated-but-empty schema
 *    no table cleared the threshold, `uncovered` was consequently empty, and the
 *    gate exited 0 having classified zero tables. "No uncovered table" meant "no
 *    table". The evidence bundle's own README concedes this at line 108: "the
 *    retention coverage gate itself is vacuous, so the drill result must not be
 *    read as 'retention is covered'".
 *
 * Every assertion here runs the SHIPPED script as a subprocess rather than
 * importing it. The module calls `process.exit()` at top level, so importing it
 * would kill the jest worker — and spawning it means what is measured is the
 * artifact the npm gate actually runs, not a testable copy of it.
 *
 * Read-only: this spec creates nothing and writes nothing. It reads pg_class.
 *
 *   COMPLIANCE_DB_TESTS=1 DATABASE_URL=postgres://neondb_owner@localhost:5432/scratch_gates_head \
 *     npx jest --runInBand --testPathPattern="retention-coverage-gate.db"
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import postgres from "postgres";

const ENABLED = process.env.COMPLIANCE_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

if (ENABLED) jest.setTimeout(180_000);

const BACKEND_ROOT = resolve(__dirname, "../..");
const GATE = resolve(BACKEND_ROOT, "src/scripts/check-retention-coverage.mjs");

interface GateRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the gate exactly as the npm script does, and never throws on a non-zero exit. */
function runGate(args: readonly string[], env: NodeJS.ProcessEnv): GateRun {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      cwd: BACKEND_ROOT,
      encoding: "utf8",
      env: { ...env, NODE_OPTIONS: "--max-old-space-size=1024" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function envWithDatabaseUrl(): NodeJS.ProcessEnv {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required when COMPLIANCE_DB_TESTS=1");
  return { ...process.env, DATABASE_URL: url };
}

function envWithoutDatabaseUrl(): NodeJS.ProcessEnv {
  const stripped = { ...process.env };
  delete stripped.DATABASE_URL;
  return stripped;
}

interface Summary {
  readonly highGrowthTables: number;
  readonly covered: number;
  readonly keepForever: number;
  readonly uncovered: number;
}

function summaryOf(run: GateRun): Summary {
  const parsed = JSON.parse(run.stdout) as { summary: Summary };
  return parsed.summary;
}

describeDb("check:retention-coverage — the gate measures a corpus before it reports on one", () => {
  let sql: ReturnType<typeof postgres>;
  let tablesInSchema = 0;

  beforeAll(async () => {
    sql = postgres(envWithDatabaseUrl().DATABASE_URL as string, {
      prepare: false,
      max: 1,
      onnotice: () => {},
    });
    const [row] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;
    tablesInSchema = Number(row?.n ?? 0);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  it("(anti-vacuity) this spec itself is pointed at a migrated schema", () => {
    expect(tablesInSchema).toBeGreaterThanOrEqual(200);
  });

  describe("defect 1 — integer division made every sub-megabyte table measure zero", () => {
    it("the integer divisor loses tables the numeric divisor keeps", async () => {
      const [row] = await sql<{ int_form: string; num_form: string; lost: string }[]>`
        SELECT
          count(*) FILTER (WHERE pg_total_relation_size(c.oid) / 1048576   >= 0.1)::text AS int_form,
          count(*) FILTER (WHERE pg_total_relation_size(c.oid) / 1048576.0 >= 0.1)::text AS num_form,
          count(*) FILTER (
            WHERE pg_total_relation_size(c.oid) / 1048576   <  0.1
              AND pg_total_relation_size(c.oid) / 1048576.0 >= 0.1
          )::text AS lost
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;

      // The bug, stated as arithmetic: tables the old formula rounded away to 0 MB.
      expect(Number(row?.lost ?? 0)).toBeGreaterThan(0);
      expect(Number(row?.num_form ?? 0)).toBeGreaterThan(Number(row?.int_form ?? 0));
    });

    it("the shipped query divides by a numeric literal, and is the one the gate runs", () => {
      const run = runGate(["--print-query"], envWithoutDatabaseUrl());
      expect(run.status).toBe(0);
      const printed = JSON.parse(run.stdout) as {
        totalMbExpression: string;
        catalogueQuery: string;
      };
      expect(printed.totalMbExpression).toMatch(/\/\s*1048576\.\d/);
      expect(printed.totalMbExpression).not.toMatch(/\/\s*1048576\s*(?![.\d])/);
      expect(printed.catalogueQuery).toContain(printed.totalMbExpression);
    });

    it("--threshold-mb below 1 now widens the selection instead of being inert", () => {
      const env = envWithDatabaseUrl();
      const atOne = runGate([], env);
      const atOneTenth = runGate(["--threshold-mb=0.1"], env);

      // Both may legitimately exit 1 (an uncovered table is a real finding); what is
      // asserted is that lowering the threshold changed what the gate looked at.
      expect([0, 1]).toContain(atOne.status);
      expect([0, 1]).toContain(atOneTenth.status);
      expect(summaryOf(atOneTenth).highGrowthTables).toBeGreaterThan(
        summaryOf(atOne).highGrowthTables,
      );
    });
  });

  describe("defect 2 — a corpus that classified nothing must not report clean", () => {
    it("a threshold no table can clear is INCONCLUSIVE (2), never a pass (0)", () => {
      const run = runGate(["--threshold-mb=100000"], envWithDatabaseUrl());
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("INCONCLUSIVE");
      // The distinguishing detail: the old script printed exactly this summary and exited 0.
      expect(run.stderr).toMatch(/0 cleared 100000 MB/);
    });

    it("an unmigrated schema is INCONCLUSIVE rather than a clean sweep of nothing", () => {
      // `template1` is a real, reachable database with no application tables in `public`.
      const url = new URL(envWithDatabaseUrl().DATABASE_URL as string);
      url.pathname = "/template1";
      const run = runGate([], { ...process.env, DATABASE_URL: url.toString() });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("INCONCLUSIVE");
    });

    it("an absent DATABASE_URL is INCONCLUSIVE, not a silent fallback to .env", () => {
      const run = runGate([], envWithoutDatabaseUrl());
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("INCONCLUSIVE");
      // dotenv.config() used to substitute the .env connection string here AND write a
      // banner to stdout, which made the JSON report unparseable. Both are gone.
      expect(run.stdout).toBe("");
    });
  });

  describe("the report the gate emits is machine-readable", () => {
    it("stdout parses as JSON with no banner ahead of it", () => {
      const run = runGate([], envWithDatabaseUrl());
      expect([0, 1]).toContain(run.status);
      expect(() => JSON.parse(run.stdout)).not.toThrow();
      expect(run.stdout.trimStart().startsWith("{")).toBe(true);
    });

    it("a real corpus is classified, not merely scanned", () => {
      const summary = summaryOf(runGate([], envWithDatabaseUrl()));
      expect(summary.highGrowthTables).toBeGreaterThan(0);
      expect(summary.covered + summary.keepForever + summary.uncovered).toBe(
        summary.highGrowthTables,
      );
    });
  });
});
