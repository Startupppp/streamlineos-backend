import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import postgres from "postgres";
import * as dotenv from "dotenv";
import { UNIT_COSTS, canContributeQuantity, detectAnomalousTenants } from "./cell-unit-costs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = resolve(__dirname, "../../../../.cell-cost-history.json");
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

function trendLine(entries, key) {
  const points = entries
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
  const dailyChange = slope * 86_400_000;
  return { slope, dailyChange, vMean, points: points.length };
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
  } catch {
    return null;
  }
}

async function main() {
  dotenv.config({ path: resolve(process.cwd(), ".env") });

  const appUrl = process.env.APP_DATABASE_URL;
  const ownerUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!appUrl) {
    process.stderr.write("APP_DATABASE_URL is required.\n");
    process.exit(1);
  }

  const SELF_TEST = process.argv.includes("--self-test");

  if (SELF_TEST) {
    const normals = Array.from({ length: 19 }, (_, i) => ({ orgId: `org-${i}`, cost: 10 + (i % 3) }));
    const syntheticSample = [...normals, { orgId: "extreme", cost: 500 }];
    const result = detectAnomalousTenants(syntheticSample, 2.0);
    if (result.status === "ok" && result.anomalous.some((a) => a.orgId === "extreme")) {
      process.stdout.write("SELF-TEST PASS: anomaly detector fired on 500-cost outlier — guard can fail\n");
      process.exitCode = 0;
    } else {
      process.stderr.write(`SELF-TEST FAIL: anomaly detector did not flag the extreme-cost outlier (status=${result.status}, anomalous=${result.anomalous?.length ?? "n/a"})\n`);
      process.exitCode = 1;
    }
    return;
  }

  const appDb = connect(appUrl);
  const ownerDb = ownerUrl ? connect(ownerUrl) : null;

  try {
    const results = [];
    for (const unit of UNIT_COSTS) {
      const r = await measureUnit(unit, appDb, ownerDb);
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
      } else {
        process.stdout.write(fmt(r.label, `${r.quantity.toLocaleString()}`));
      }
    }

    process.stdout.write("─".repeat(80) + "\n");

    const history = loadHistory();
    const nowTs = Date.now();

    const activeOrgsResult = results.find((r) => r.id === "per-active-org" && r.status === "ok");
    const aiResult = results.find((r) => r.id === "per-ai-token" && r.status === "ok");
    const storageResult = results.find((r) => r.id === "per-gb-stored" && r.status === "ok");

    const entry = { ts: nowTs, cellId: CELL_ID };
    if (activeOrgsResult) entry.activeOrgs = activeOrgsResult.quantity;
    if (aiResult) {
      entry.totalTokens = aiResult.quantity;
      entry.creditsMilli = aiResult.creditsMilli ?? 0;
      if (aiResult.quantity > 0)
        entry.milliCreditsPerToken = (aiResult.creditsMilli ?? 0) / aiResult.quantity;
    }
    if (storageResult) entry.dbSizeGb = storageResult.quantity;

    history.entries.push(entry);
    saveHistory(history);

    process.stdout.write("\nCost-per-unit trends (from history):\n");
    const tokenTrend = trendLine(history.entries, "milliCreditsPerToken");
    if (tokenTrend)
      process.stdout.write(
        `  AI cost/token: ${tokenTrend.vMean.toFixed(4)} milli-credits/token avg,` +
          ` ${tokenTrend.dailyChange >= 0 ? "+" : ""}${tokenTrend.dailyChange.toFixed(6)}/day over ${tokenTrend.points} samples\n`,
      );
    else
      process.stdout.write("  AI cost/token: REFUSED — fewer than 3 history samples\n");

    process.stdout.write("\nMonthly cost forecast:\n");
    if (!activeOrgsResult)
      process.stdout.write("  REFUSED — active org count not measured (occupancy unknown; a cheap empty cell is not a finding)\n");
    else if (activeOrgsResult.quantity < 3)
      process.stdout.write(`  REFUSED — only ${activeOrgsResult.quantity} active org(s); cell may be empty; forecast would be misleading\n`);
    else {
      const creditTrend = trendLine(history.entries, "creditsMilli");
      if (!creditTrend)
        process.stdout.write("  REFUSED — fewer than 3 history samples for AI credit projection\n");
      else {
        const projectedMonthlyMilli = Math.max(0, creditTrend.vMean + creditTrend.dailyChange * 30);
        process.stdout.write(
          `  Projected monthly AI credits: ${(projectedMonthlyMilli / 1000).toFixed(2)} credits (${activeOrgsResult.quantity} active orgs)\n`,
        );
        process.stdout.write(
          `  AI cost note: dollar value requires credit-to-USD rate from the billing config.\n`,
        );
        process.stdout.write(
          `  Non-AI cost units are UNMEASURED — provide the cell's monthly Neon invoice for a full forecast.\n`,
        );
      }
    }

    const orgSample = await sampleAiCostByOrg(ownerDb, 50);
    process.stdout.write("\nAI cost anomaly check (last 30 days, sample of up to 50 orgs):\n");
    if (!ownerDb) {
      process.stdout.write("  SKIPPED — provide DATABASE_URL for cross-tenant sampling\n");
    } else if (!orgSample) {
      process.stdout.write("  SKIPPED — query failed (see errors above)\n");
    } else if (orgSample.length < 3) {
      process.stdout.write(`  REFUSED — only ${orgSample.length} org(s) with AI usage in the last 30 days; need at least 3 for anomaly detection\n`);
    } else {
      const detection = detectAnomalousTenants(orgSample, 2.5);
      if (detection.status === "refused")
        process.stdout.write(`  REFUSED — ${detection.reason}\n`);
      else if (detection.anomalous.length === 0)
        process.stdout.write(`  No anomalous orgs detected (mean=${detection.mean?.toFixed(0)} milli-credits, σ=${detection.stdDev?.toFixed(0)})\n`);
      else {
        process.stdout.write(`  ${detection.anomalous.length} org(s) exceed 2.5σ — review for throttling or relocation:\n`);
        for (const a of detection.anomalous)
          process.stdout.write(`    org ${a.orgId} — ${a.cost} milli-credits\n`);
      }
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
