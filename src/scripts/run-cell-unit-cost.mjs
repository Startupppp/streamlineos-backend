import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import postgres from "postgres";
import * as dotenv from "dotenv";
import { UNIT_COSTS, canContributeQuantity, detectAnomalousTenants } from "./cell-unit-costs.mjs";
import { forecastSaturation, filterWellSpacedSamples, MIN_SAMPLE_SPACING_MS } from "./cell-capacity-budgets.mjs";
import { fetchNeonConsumption, fetchAblyStats, fetchResendStats, fetchCloudflareR2Stats } from "./cell-cost/vendor-costs.mjs";
import { readLoadDriverResults, isDuringBulkLoad, EXPECTED_FIELDS } from "./cell-cost/load-driver-reader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = resolve(__dirname, "../../.cell-cost-history.json");
const CAP_HISTORY_PATH = resolve(__dirname, "../../.cell-capacity-history.json");
const LOAD_DRIVER_PATH = resolve(__dirname, "../../.load-driver-results.json");
const CELL_ID = process.env.CELL_ID ?? "legacy-1";

function loadHistory(path) {
  if (!existsSync(path)) return { entries: [] };
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return { entries: [] }; }
}

function saveHistory(history) {
  const trimmed = { entries: history.entries.slice(-90) };
  writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2), "utf8");
}

function connect(url) {
  const ssl = process.env.PGSSLMODE === "disable" ? false : "require";
  return postgres(url, { max: 1, prepare: false, ssl, onnotice: () => {} });
}

function trendLine(entries, key) {
  const spaced = filterWellSpacedSamples(entries.filter((e) => !e.duringBulkLoad));
  const points = spaced
    .filter((e) => e[key] != null && Number.isFinite(e[key]))
    .map((e) => ({ t: e.ts, v: e[key] }))
    .sort((a, b) => a.t - b.t);
  if (points.length < 3) return null;
  const n = points.length;
  const tMean = points.reduce((s, p) => s + p.t, 0) / n;
  const vMean = points.reduce((s, p) => s + p.v, 0) / n;
  const num = points.reduce((s, p) => s + (p.t - tMean) * (p.v - vMean), 0);
  const den = points.reduce((s, p) => s + (p.t - tMean) ** 2, 0);
  if (den === 0) return null;
  const slope = num / den;
  return { slope, dailyChange: slope * 86_400_000, vMean, points: points.length };
}

async function measureUnit(unit, appDb, ownerDb) {
  if (!canContributeQuantity(unit))
    return { id: unit.id, label: unit.label, source: unit.source, status: "unmeasured" };
  const db = unit.requiresOwnerRole ? ownerDb : appDb;
  if (!db)
    return { id: unit.id, label: unit.label, source: unit.source, status: "skipped", reason: "owner role required; provide DATABASE_URL" };
  try {
    const [row] = await db.unsafe(unit.countSql);
    const quantity = Number(row.quantity ?? 0);
    const extra = {};
    if (row.credits_milli_total != null) extra.creditsMilli = Number(row.credits_milli_total);
    if (row.cost_usd != null) extra.costUsd = Number(row.cost_usd);
    return { id: unit.id, label: unit.label, source: unit.source, status: "ok", quantity, ...extra };
  } catch (err) {
    return { id: unit.id, label: unit.label, source: unit.source, status: "error", message: String(err.message ?? err) };
  }
}

async function sampleAiCostByOrg(ownerDb, sampleSize) {
  if (!ownerDb) return null;
  try {
    const rows = await ownerDb.unsafe(`
      SELECT org_id, sum(credits_milli)::bigint AS cost
      FROM ai_usage_logs
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY org_id
      ORDER BY cost DESC
      LIMIT ${sampleSize}`);
    return rows.map((r) => ({ orgId: r.org_id, cost: Number(r.cost) }));
  } catch { return null; }
}

function printSpacingStatus(history) {
  const spaced = filterWellSpacedSamples(history.entries.filter((e) => !e.duringBulkLoad));
  const spacingDays = Math.round(MIN_SAMPLE_SPACING_MS / 86_400_000);
  const last = spaced.length > 0 ? spaced[spaced.length - 1] : null;
  const nextAfter = last ? new Date(last.ts + MIN_SAMPLE_SPACING_MS).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "now";
  process.stdout.write(`\nSampling status:\n`);
  process.stdout.write(`  Total cost samples    ${history.entries.length}\n`);
  process.stdout.write(`  Well-spaced (≥${spacingDays}d)    ${spaced.length} of 3 needed\n`);
  process.stdout.write(`  Trend ready           ${spaced.length >= 3 ? "YES" : "NO — need more daily samples"}\n`);
  if (spaced.length < 3) process.stdout.write(`  Next sample after     ${nextAfter}\n`);
}

async function main() {
  dotenv.config({ path: resolve(process.cwd(), ".env") });

  const appUrl = process.env.APP_DATABASE_URL;
  const ownerUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!appUrl) { process.stderr.write("APP_DATABASE_URL is required.\n"); process.exit(1); }

  const SELF_TEST = process.argv.includes("--self-test");
  const RECORD_ONLY = process.argv.includes("--record-only");

  if (SELF_TEST) {
    const normals = Array.from({ length: 19 }, (_, i) => ({ orgId: `org-${i}`, cost: 10 + (i % 3) }));
    const result = detectAnomalousTenants([...normals, { orgId: "extreme", cost: 500 }], 2.0);
    if (result.status === "ok" && result.anomalous.some((a) => a.orgId === "extreme")) {
      process.stdout.write("SELF-TEST PASS: anomaly detector fired on 500-cost outlier — guard can fail\n");
    } else {
      process.stderr.write(`SELF-TEST FAIL: anomaly detector did not flag the extreme-cost outlier\n`);
      process.exitCode = 1;
    }
    return;
  }

  const appDb = connect(appUrl);
  const ownerDb = ownerUrl ? connect(ownerUrl) : null;

  try {
    const loadDriver = readLoadDriverResults(LOAD_DRIVER_PATH);
    const duringLoad = loadDriver?.status === "ok" && isDuringBulkLoad(loadDriver.modifiedAt);

    if (duringLoad) process.stdout.write("WARNING: load driver results file was modified within the last hour; this sample may reflect bulk-load conditions, not steady-state growth.\n");

    const results = [];
    for (const unit of UNIT_COSTS) {
      let r = await measureUnit(unit, appDb, ownerDb);
      if (r.status === "unmeasured" && unit.id === "per-1k-requests" && loadDriver?.status === "ok" && loadDriver.requestCount != null) {
        r = { id: unit.id, label: unit.label, source: "dynamic", status: "ok", quantity: loadDriver.requestCount, durationMs: loadDriver.durationMs };
      }
      results.push(r);
    }

    process.stdout.write(`\nCell: ${CELL_ID} — unit cost snapshot\n`);
    process.stdout.write("─".repeat(80) + "\n");
    const fmt = (label, val) => `  ${label.padEnd(36)} ${val}\n`;

    for (const r of results) {
      if (r.status === "unmeasured") {
        const info = UNIT_COSTS.find((u) => u.id === r.id);
        process.stdout.write(fmt(r.label, `UNMEASURED — requires: ${info.requiredInput}`));
      } else if (r.status === "skipped") {
        process.stdout.write(fmt(r.label, `SKIPPED — ${r.reason}`));
      } else if (r.status === "error") {
        process.stdout.write(fmt(r.label, `ERROR — ${r.message}`));
      } else if (r.source === "ledger") {
        process.stdout.write(fmt(r.label, `${r.quantity.toLocaleString()} tokens · ${(r.creditsMilli ?? 0) / 1000} credits · $${(r.costUsd ?? 0).toFixed(4)}`));
      } else if (r.source === "dynamic") {
        process.stdout.write(fmt(r.label, `${r.quantity.toLocaleString()} requests over ${Math.round((r.durationMs ?? 0) / 1000)}s (load driver)`));
      } else {
        process.stdout.write(fmt(r.label, `${r.quantity.toLocaleString()}`));
      }
    }
    process.stdout.write("─".repeat(80) + "\n");

    const history = loadHistory(HISTORY_PATH);
    const nowTs = Date.now();
    const activeOrgsResult = results.find((r) => r.id === "per-active-org" && r.status === "ok");
    const aiResult = results.find((r) => r.id === "per-ai-token" && r.status === "ok");
    const storageResult = results.find((r) => r.id === "per-gb-stored" && r.status === "ok");

    const prevWellSpaced = filterWellSpacedSamples(history.entries.filter((e) => !e.duringBulkLoad));
    const lastWS = prevWellSpaced.length > 0 ? prevWellSpaced[prevWellSpaced.length - 1] : null;
    const tooClose = lastWS !== null && nowTs - lastWS.ts < MIN_SAMPLE_SPACING_MS;

    const entry = { ts: nowTs, cellId: CELL_ID };
    if (tooClose) entry.tooCloseToPrevious = true;
    if (duringLoad) entry.duringBulkLoad = true;
    if (activeOrgsResult) entry.activeOrgs = activeOrgsResult.quantity;
    if (aiResult) {
      entry.totalTokens = aiResult.quantity;
      entry.creditsMilli = aiResult.creditsMilli ?? 0;
      if (aiResult.quantity > 0) entry.milliCreditsPerToken = (aiResult.creditsMilli ?? 0) / aiResult.quantity;
    }
    if (storageResult) entry.dbSizeGb = storageResult.quantity;
    history.entries.push(entry);
    saveHistory(history);

    if (RECORD_ONLY) {
      printSpacingStatus(history);
      process.stdout.write("\nSample recorded. Re-run without --record-only after accumulating 3 well-spaced samples to generate forecasts.\n");
      return;
    }

    await reportVendorCosts();

    process.stdout.write("\nCost-per-unit trends (from history):\n");
    const tokenTrend = trendLine(history.entries, "milliCreditsPerToken");
    if (tokenTrend)
      process.stdout.write(`  AI cost/token: ${tokenTrend.vMean.toFixed(4)} milli-credits/token avg, ${tokenTrend.dailyChange >= 0 ? "+" : ""}${tokenTrend.dailyChange.toFixed(6)}/day over ${tokenTrend.points} samples\n`);
    else {
      const spaced = filterWellSpacedSamples(history.entries.filter((e) => !e.duringBulkLoad));
      process.stdout.write(`  AI cost/token: REFUSED — ${spaced.length} well-spaced sample(s) of ${history.entries.length} total; need 3 each ≥${Math.round(MIN_SAMPLE_SPACING_MS / 86_400_000)}d apart\n`);
    }

    process.stdout.write("\nMonthly cost + saturation forecast:\n");
    if (!activeOrgsResult) {
      process.stdout.write("  REFUSED — active org count not measured (occupancy unknown; a cheap empty cell is not a finding)\n");
    } else if (activeOrgsResult.quantity < 3) {
      process.stdout.write(`  REFUSED — only ${activeOrgsResult.quantity} active org(s); cell may be empty; forecast would be misleading\n`);
    } else {
      process.stdout.write(`  Occupancy: ${activeOrgsResult.quantity} active org(s)\n`);
      const creditTrend = trendLine(history.entries, "creditsMilli");
      if (!creditTrend) {
        const spaced = filterWellSpacedSamples(history.entries.filter((e) => !e.duringBulkLoad));
        process.stdout.write(`  AI cost forecast: REFUSED — ${spaced.length} well-spaced sample(s); need 3 each ≥${Math.round(MIN_SAMPLE_SPACING_MS / 86_400_000)}d apart\n`);
      } else {
        const projMonthly = Math.max(0, creditTrend.vMean + creditTrend.dailyChange * 30);
        process.stdout.write(`  Projected monthly AI credits: ${(projMonthly / 1000).toFixed(2)} (${activeOrgsResult.quantity} active orgs)\n`);
        process.stdout.write(`  AI cost note: dollar value requires credit-to-USD rate from the billing config.\n`);
        process.stdout.write(`  Non-AI cost units: UNMEASURED without Neon/Resend/Cloudflare vendor API credentials.\n`);
      }

      const capHistory = loadHistory(CAP_HISTORY_PATH);
      if (capHistory.entries.length > 0) {
        const resourceIds = new Set(capHistory.entries.flatMap((e) => Object.keys(e.resources ?? {})));
        process.stdout.write(`\n  Saturation (${capHistory.entries.length} capacity sample(s)):\n`);
        for (const rid of resourceIds) {
          const fc = forecastSaturation(capHistory.entries, rid);
          const line = fc.status === "forecast" ? `${fc.daysUntilThreshold}d until 60%` : `REFUSED — ${fc.reason}`;
          process.stdout.write(`    ${rid.padEnd(32)} ${line}\n`);
        }
      } else process.stdout.write(`\n  Saturation: no capacity history — run run-cell-capacity.mjs to record samples.\n`);
    }

    const orgSample = await sampleAiCostByOrg(ownerDb, 50);
    process.stdout.write("\nAI cost anomaly check (last 30 days, sample of up to 50 orgs):\n");
    if (!ownerDb) {
      process.stdout.write("  SKIPPED — provide DATABASE_URL for cross-tenant sampling\n");
    } else if (!orgSample) {
      process.stdout.write("  SKIPPED — query failed (see errors above)\n");
    } else if (orgSample.length < 3) {
      process.stdout.write(`  REFUSED — only ${orgSample.length} org(s) with AI usage; need at least 3 for anomaly detection\n`);
    } else {
      const detection = detectAnomalousTenants(orgSample, 2.5);
      if (detection.status === "refused")
        process.stdout.write(`  REFUSED — ${detection.reason}\n`);
      else if (detection.anomalous.length === 0)
        process.stdout.write(`  No anomalous orgs detected (mean=${detection.mean?.toFixed(0)} milli-credits, σ=${detection.stdDev?.toFixed(0)})\n`);
      else {
        process.stdout.write(`  ${detection.anomalous.length} org(s) exceed 2.5σ — review for throttling or relocation:\n`);
        for (const a of detection.anomalous) process.stdout.write(`    org ${a.orgId} — ${a.cost} milli-credits\n`);
      }
    }

    if (loadDriver === null) {
      process.stdout.write(`\nLoad driver: .load-driver-results.json not found at ${LOAD_DRIVER_PATH}\n`);
      process.stdout.write(`  Expected fields: ${Object.keys(EXPECTED_FIELDS).join(", ")}\n`);
    } else if (loadDriver?.status === "parse-error") {
      process.stdout.write(`\nLoad driver: file exists but could not be parsed (${loadDriver.reason ?? "JSON error"})\n`);
    }

    printSpacingStatus(history);
  } finally {
    await appDb.end();
    if (ownerDb) await ownerDb.end();
  }
}

async function reportVendorCosts() {
  const env = process.env;
  process.stdout.write("\nVendor cost data:\n");

  const neon = await fetchNeonConsumption(env);
  if (neon.status === "refused")
    process.stdout.write(`  Neon:       REFUSED — ${neon.reason}\n`);
  else if (neon.status === "error")
    process.stdout.write(`  Neon:       ERROR — ${neon.reason}\n`);
  else {
    const computeHours = neon.computeTimeSeconds != null ? (neon.computeTimeSeconds / 3600).toFixed(2) + "h compute" : "compute n/a";
    const storageGib = neon.storageGibHours != null ? neon.storageGibHours.toFixed(3) + " GiB·h storage" : "storage n/a";
    process.stdout.write(`  Neon:       ${computeHours} · ${storageGib} · ${neon.rateNote}\n`);
  }

  const ably = await fetchAblyStats(env);
  if (ably.status === "refused")
    process.stdout.write(`  Ably:       REFUSED — ${ably.reason}\n`);
  else if (ably.status === "error")
    process.stdout.write(`  Ably:       ERROR — ${ably.reason}\n`);
  else {
    const cm = ably.channelMinutes != null ? `${ably.channelMinutes.toLocaleString()} channel-minutes` : "channel-minutes n/a";
    process.stdout.write(`  Ably:       ${cm} · ${ably.messageCount?.toLocaleString() ?? "?"} messages · ${ably.note ?? ""}\n`);
  }

  const resend = await fetchResendStats(env);
  if (resend.status === "refused")
    process.stdout.write(`  Resend:     REFUSED — ${resend.reason}\n`);
  else
    process.stdout.write(`  Resend:     KEY PRESENT — ${resend.note}\n`);

  const r2 = await fetchCloudflareR2Stats(env);
  if (r2.status === "refused")
    process.stdout.write(`  R2:         REFUSED — ${r2.reason}\n`);
  else if (r2.status === "error")
    process.stdout.write(`  R2:         ERROR — ${r2.reason}\n`);
  else {
    const gb = (r2.storageBytes / (1024 ** 3)).toFixed(3);
    process.stdout.write(`  R2:         ${gb} GB · ${r2.classAOperations.toLocaleString()} Class-A ops · ${r2.classBOperations.toLocaleString()} Class-B ops · ${r2.rateNote}\n`);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`RUNNER FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
