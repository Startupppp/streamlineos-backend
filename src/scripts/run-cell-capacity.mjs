import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import postgres from "postgres";
import * as dotenv from "dotenv";

const PRODUCTION_HOST_PATTERNS = ["amazonaws.com", "neon.tech", "neon-db.net", "supabase.co", ".render.com"];

function assertBootstrapTarget(url, allowProduction) {
  if (!url) return { allowed: false, reason: "DATABASE_URL is not set" };
  const matched = PRODUCTION_HOST_PATTERNS.find((p) => url.includes(p));
  if (!matched) return { allowed: true, reason: "not a known production host" };
  if (allowProduction === "1") return { allowed: true, reason: `production host '${matched}' — ALLOW_PRODUCTION_MIGRATION=1 acknowledged` };
  return { allowed: false, reason: `DATABASE_URL names production host '${matched}'; set ALLOW_PRODUCTION_MIGRATION=1 to proceed deliberately` };
}

if (process.argv.includes("--self-test")) {
  const cases = [
    [assertBootstrapTarget("postgresql://u:p@127.0.0.1:5432/app", undefined), true],
    [assertBootstrapTarget("postgresql://u:p@prod.cluster.amazonaws.com/app", undefined), false],
    [assertBootstrapTarget("postgresql://u:p@prod.cluster.amazonaws.com/app", "1"), true],
    [assertBootstrapTarget("postgresql://u:p@db.neon.tech/neondb", undefined), false],
    [assertBootstrapTarget(undefined, undefined), false],
  ];
  let failed = 0;
  for (const [verdict, expected] of cases)
    if (verdict.allowed !== expected) { console.error(`FAIL: expected allowed=${expected}, got '${verdict.reason}'`); failed++; }
  if (failed) process.exit(1);
  console.log("PASS: run-cell-capacity target guard, 5 cases.");
  process.exit(0);
}

import {
  CAPACITY_BUDGETS,
  ADMISSION_THRESHOLD,
  validateCapacityBudgets,
  advisoryResources,
  identifyLimitingResource,
  checkAdmission,
  forecastSaturation,
  filterWellSpacedSamples,
  MIN_SAMPLE_SPACING_MS,
} from "./cell-capacity-budgets.mjs";
import { readLoadDriverResults, isDuringBulkLoad } from "./cell-cost/load-driver-reader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = resolve(__dirname, "../../.cell-capacity-history.json");
const LOAD_DRIVER_PATH = resolve(__dirname, "../../.load-driver-results.json");
const CELL_ID = process.env.CELL_ID ?? "legacy-1";

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function saveHistory(history) {
  const trimmed = { entries: history.entries.slice(-90) };
  writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2), "utf8");
}

function connect(url) {
  const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
  return postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });
}

async function measureBudget(budget, db) {
  const effectiveCeiling =
    budget.id === "database-size"
      ? Number(process.env.CELL_STORAGE_LIMIT_BYTES ?? budget.ceilingValue)
      : budget.ceilingValue ?? null;

  try {
    const [usageRow] = await db.unsafe(budget.usageSql);
    const used = Number(usageRow.used);

    let limit;
    if (budget.ceilingSql) {
      const [limitRow] = await db.unsafe(budget.ceilingSql);
      limit = Number(limitRow.limit);
    } else {
      limit = effectiveCeiling;
    }

    if (limit == null || !Number.isFinite(limit) || limit <= 0)
      return { status: "no-ceiling", id: budget.id, resource: budget.resource, unit: budget.unit };

    const ratio = used / limit;
    return {
      status: "measured",
      id: budget.id,
      resource: budget.resource,
      unit: budget.unit,
      used,
      limit,
      ratio,
      ceilingSource: budget.ceilingSource,
      admissionGating: budget.admissionGating,
    };
  } catch (err) {
    return { status: "error", id: budget.id, resource: budget.resource, message: String(err.message ?? err) };
  }
}

async function measurePerOrgCost(db, limiting) {
  const [{ n }] = await db`
    SELECT count(*)::int AS n FROM organization_placement WHERE status = 'ACTIVE'`;
  const organizations = Number(n);
  if (organizations === 0) return limiting.limit;
  return limiting.used / organizations;
}

async function main() {
  dotenv.config({ path: resolve(process.cwd(), ".env") });

  const appUrl = process.env.APP_DATABASE_URL;
  const ownerUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;

  const _cellCapGuard = assertBootstrapTarget(ownerUrl, process.env.ALLOW_PRODUCTION_MIGRATION);
  if (!_cellCapGuard.allowed) {
    process.stderr.write(`run-cell-capacity BLOCKED — ${_cellCapGuard.reason}\n`);
    process.exit(2);
  }

  if (!appUrl) {
    process.stderr.write("APP_DATABASE_URL is required (the non-BYPASSRLS app role).\n");
    process.exit(1);
  }

  const SELF_TEST = process.argv.includes("--self-test");
  const JSON_OUT = process.argv.includes("--json");
  const RECORD_ONLY = process.argv.includes("--record-only");

  const validationErrors = validateCapacityBudgets(CAPACITY_BUDGETS);
  if (validationErrors.length > 0) {
    for (const e of validationErrors) process.stderr.write(`INVALID BUDGET: ${e}\n`);
    process.exit(1);
  }

  const appDb = connect(appUrl);
  const ownerDb = ownerUrl ? connect(ownerUrl) : null;

  try {
    let budgets = CAPACITY_BUDGETS;

    if (SELF_TEST) {
      const selfTestBudget = CAPACITY_BUDGETS.find((b) => !b.requiresOwnerRole);
      if (!selfTestBudget) {
        process.stderr.write("SELF-TEST FAIL: no app-role budget available to probe.\n");
        process.exitCode = 1;
        return;
      }
      budgets = [{ ...selfTestBudget, id: "self-test", ceilingValue: 1, ceilingSql: undefined }];
    }

    const measurements = [];
    const nowTs = Date.now();

    for (const budget of budgets) {
      const db = budget.requiresOwnerRole ? ownerDb : appDb;

      if (!db) {
        if (!SELF_TEST && !JSON_OUT)
          process.stdout.write(
            `SKIP  ${budget.id.padEnd(32)} owner role required — provide DATABASE_URL to measure\n`,
          );
        continue;
      }

      const result = await measureBudget(budget, db);

      if (result.status === "no-ceiling") {
        if (!SELF_TEST && !JSON_OUT)
          process.stdout.write(`SKIP  ${result.id.padEnd(32)} no measurable ceiling\n`);
        continue;
      }

      if (result.status === "error") {
        if (!SELF_TEST && !JSON_OUT)
          process.stderr.write(`FAIL  ${result.id.padEnd(32)} error: ${result.message}\n`);
        continue;
      }

      measurements.push(result);

      if (!SELF_TEST && !JSON_OUT) {
        const ceilTag =
          result.ceilingSource === "measured" ? "" : ` [${result.ceilingSource} ceiling]`;
        const verdict =
          result.admissionGating === false
            ? "ADV "
            : checkAdmission(result.ratio)
              ? "OK  "
              : "OVER";
        process.stdout.write(
          `${verdict}  ${result.id.padEnd(32)}` +
            ` used=${result.used} / limit=${result.limit} (${(result.ratio * 100).toFixed(1)}%)${ceilTag}\n`,
        );
      }
    }

    if (SELF_TEST) {
      const breached = measurements.some((m) => m.ratio > 0);
      if (breached) {
        process.stdout.write("SELF-TEST PASS: breach detected — guard can fail\n");
        process.exitCode = 0;
      } else {
        process.stderr.write("SELF-TEST FAIL: ceiling of 0 was not detected as a breach — guard cannot fail\n");
        process.exitCode = 1;
      }
      return;
    }

    if (measurements.length === 0) {
      process.stderr.write(
        "REFUSED: no resources could be measured. Provide DATABASE_URL for owner-role measurements or check connectivity.\n",
      );
      process.exitCode = 1;
      return;
    }

    const limiting = identifyLimitingResource(measurements);
    if (limiting === null) {
      process.stderr.write(
        "REFUSED: no admission-gating resource could be measured. " +
          "An advisory-only reading is not a capacity budget.\n",
      );
      process.exitCode = 1;
      return;
    }
    const admitted = checkAdmission(limiting.ratio);

    if (JSON_OUT) {
      process.stdout.write(
        JSON.stringify([
          {
            cellId: CELL_ID,
            limitingResource: limiting.resource,
            used: limiting.used,
            limit: limiting.limit,
            measuredAt: nowTs,
          },
        ]) + "\n",
      );
      if (!admitted) process.exitCode = 1;
      return;
    }

    for (const a of advisoryResources(measurements))
      process.stdout.write(
        `\nAdvisory, never gates admission: ${a.resource} at ${(a.ratio * 100).toFixed(1)}%\n`,
      );

    process.stdout.write(`\nLimiting resource: ${limiting.resource} (${(limiting.ratio * 100).toFixed(1)}%)\n`);
    process.stdout.write(
      `Admission threshold: ${(ADMISSION_THRESHOLD * 100).toFixed(0)}% — cell is ${admitted ? "OPEN" : "CLOSED (threshold exceeded)"}\n`,
    );

    const loadDriver = readLoadDriverResults(LOAD_DRIVER_PATH);
    const duringLoad = loadDriver?.status === "ok" && isDuringBulkLoad(loadDriver.modifiedAt);
    if (duringLoad) process.stdout.write("\nWARNING: load driver results file was modified within the last hour; this sample reflects bulk-load conditions. It will be recorded but flagged entries cannot be used for growth-rate trend fitting.\n");

    const history = loadHistory();
    const resourceSnapshot = {};
    for (const m of measurements)
      resourceSnapshot[m.id] = { used: m.used, limit: m.limit };

    const prevWellSpaced = filterWellSpacedSamples(history.entries.filter((e) => !e.duringBulkLoad));
    const lastWS = prevWellSpaced.length > 0 ? prevWellSpaced[prevWellSpaced.length - 1] : null;
    const tooClose = lastWS !== null && nowTs - lastWS.ts < MIN_SAMPLE_SPACING_MS;

    history.entries.push({ ts: nowTs, cellId: CELL_ID, resources: resourceSnapshot, duringBulkLoad: duringLoad || undefined, tooCloseToPrevious: tooClose || undefined });
    saveHistory(history);

    const spacingDays = Math.round(MIN_SAMPLE_SPACING_MS / 86_400_000);
    const wellSpaced = filterWellSpacedSamples(history.entries.filter((e) => !e.duringBulkLoad));
    const last = wellSpaced.length > 0 ? wellSpaced[wellSpaced.length - 1] : null;
    const nextAfter = last ? new Date(last.ts + MIN_SAMPLE_SPACING_MS).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "now";

    process.stdout.write(`\nSampling status: ${wellSpaced.length} well-spaced sample(s) (≥${spacingDays}d apart) of ${history.entries.length} total; need 3 to fit saturation trend.\n`);
    if (wellSpaced.length < 3) process.stdout.write(`  Next sample must be after ${nextAfter}. Use --record-only on a daily schedule.\n`);

    if (RECORD_ONLY) {
      process.stdout.write("Sample recorded (--record-only). Re-run without --record-only after accumulating 3 well-spaced samples.\n");
      return;
    }

    const recorder = ownerDb ?? appDb;
    const perOrgCost = await measurePerOrgCost(recorder, limiting);
    await recorder`
      INSERT INTO cell_capacity_measurements
        (cell_id, limiting_resource, used, limit_value, per_org_cost, ceiling_source, measured_at)
      VALUES (${CELL_ID}, ${limiting.resource}, ${limiting.used}, ${limiting.limit},
              ${perOrgCost}, ${limiting.ceilingSource}, ${new Date(nowTs)})`;
    process.stdout.write(
      `\nRecorded in cell_capacity_measurements — admission reads this row.` +
        ` per-organization cost ${perOrgCost.toFixed(2)} ${limiting.unit}\n`,
    );

    process.stdout.write("\nSaturation forecasts:\n");
    for (const m of measurements) {
      const fc = forecastSaturation(history.entries, m.id);
      if (fc.status === "forecast")
        process.stdout.write(`  ${m.id.padEnd(32)} ${fc.daysUntilThreshold} day(s) until ${(ADMISSION_THRESHOLD * 100).toFixed(0)}% threshold\n`);
      else
        process.stdout.write(`  ${m.id.padEnd(32)} REFUSED — ${fc.reason}\n`);
    }

    if (!admitted) {
      process.stderr.write(
        `\nADMISSION REFUSED: ${limiting.resource} at ${(limiting.ratio * 100).toFixed(1)}%` +
          ` exceeds the ${(ADMISSION_THRESHOLD * 100).toFixed(0)}% threshold.\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    await appDb.end();
    if (ownerDb) await ownerDb.end();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`RUNNER FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
