/**
 * Alert: noisy-neighbour tenant AI cost detection.
 *
 * SOURCE: direct query to ai_usage_logs (owner role — BYPASSRLS).
 *
 * ai_usage_logs records every AI feature call with the org, model, token counts,
 * estimated_cost_usd and credits_milli. This alert computes per-org credit consumption
 * over a rolling window and fires when any org's share exceeds MULTIPLIER × the median
 * org consumption. This is a noisy-neighbour signal, not an absolute cost threshold.
 *
 * Table: ai_usage_logs (org_id, credits_milli, created_at, feature, model, total_tokens)
 * Metric: SUM(credits_milli) per org over the window.
 *
 * WHAT IS NOT MEASURABLE HERE:
 *   - CPU/memory/network consumption per tenant (no per-tenant compute attribution)
 *   - DB query cost per tenant (pool telemetry is aggregate, not per-tenant)
 *   - Object storage per tenant (no per-tenant storage ledger in this schema)
 *   - Redis memory per tenant (shared Upstash instance, no per-key accounting)
 *   Only AI token/credit spend has a per-tenant ledger in the current schema.
 *
 * MINIMUM ORG COUNT: fires only when at least --min-orgs (default 3) distinct orgs
 * have AI usage in the window, so a solo org never triggers the relative comparison.
 *
 * Usage:
 *   node alert-tenant-cost.mjs
 *   node alert-tenant-cost.mjs --window-hours=24 --multiplier=5 --min-orgs=3
 *   node alert-tenant-cost.mjs --self-test
 *
 * Exit codes:
 *   0 = clear (no noisy neighbour detected or not enough orgs for comparison)
 *   1 = fired (at least one org exceeds multiplier × median)
 *   2 = configuration error
 */
import { resolve } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

/**
 * `quiet` because stdout is the alert payload. dotenv prints a banner there
 * by default, which makes `pnpm alert:… | jq` fail on the first character —
 * so the rows naming the affected organisations could not be read by the
 * oncall integration these scripts exist to feed.
 */
dotenv.config({ path: resolve(process.cwd(), ".env"), quiet: true });

const args = process.argv.slice(2);
const windowHours = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--window-hours="))?.slice(15) ?? "24", 10),
);
const multiplier = Math.max(
  2,
  parseFloat(args.find((a) => a.startsWith("--multiplier="))?.slice(13) ?? "3"),
);
const minOrgs = Math.max(
  1,
  parseInt(args.find((a) => a.startsWith("--min-orgs="))?.slice(11) ?? "3", 10),
);
const featureScope = args.find((a) => a.startsWith("--feature="))?.slice(10) ?? "";

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function evaluateUsage(rows) {
  if (rows.length < minOrgs) {
    return {
      fired: false,
      reason: `fewer-than-min-orgs: ${rows.length} < ${minOrgs}`,
      orgCount: rows.length,
      noisy: [],
    };
  }

  const sorted = rows.map((r) => Number(r.total_credits ?? 0)).sort((a, b) => a - b);
  const med = median(sorted);
  const threshold = med * multiplier;

  const noisy = rows
    .map((r) => ({
      org_id: r.org_id,
      plan_tier: r.plan_tier ?? null,
      total_credits: Number(r.total_credits ?? 0),
      request_count: Number(r.request_count ?? 0),
      top_feature: r.top_feature,
    }))
    .filter((r) => r.total_credits > threshold && threshold > 0)
    .sort((a, b) => b.total_credits - a.total_credits);

  return {
    fired: noisy.length > 0,
    orgCount: rows.length,
    medianCredits: Math.round(med),
    thresholdCredits: Math.round(threshold),
    multiplier,
    noisy,
  };
}

if (args.includes("--self-test")) {
  const normalOrgs = Array.from({ length: 5 }, (_, i) => ({
    org_id: `org_normal_${i}`,
    plan_tier: "STARTER",
    total_credits: "100",
    request_count: "10",
    top_feature: "chat",
  }));
  const noisyOrg = {
    org_id: "org_noisy",
    plan_tier: "TRIAL",
    total_credits: "10000",
    request_count: "1000",
    top_feature: "bulk-summarise",
  };
  const tinyOrgs = [
    { org_id: "org_a", plan_tier: null, total_credits: "50", request_count: "5", top_feature: "chat" },
    { org_id: "org_b", plan_tier: null, total_credits: "50", request_count: "5", top_feature: "chat" },
  ];

  const case1 = evaluateUsage([...normalOrgs, noisyOrg]);
  const case2 = evaluateUsage(normalOrgs);
  const case3 = evaluateUsage(tinyOrgs);

  const kbOrgs = Array.from({ length: 5 }, (_, i) => ({
    org_id: `org_kb_${i}`,
    plan_tier: "STARTER",
    total_credits: "100",
    request_count: "10",
    top_feature: "kb.ask",
  }));
  const kbNoisyOrg = {
    org_id: "org_kb_noisy",
    plan_tier: "TRIAL",
    total_credits: "10000",
    request_count: "500",
    top_feature: "kb.embed",
  };
  const case4 = evaluateUsage([...kbOrgs, kbNoisyOrg]);

  const checks = {
    noisyOrgDetected: case1.fired && case1.noisy[0]?.org_id === "org_noisy",
    allNormalClear: !case2.fired,
    tooFewOrgsClear: !case3.fired && typeof case3.reason === "string",
    featureScopeDefaultIsAll: featureScope === "",
    kbScopedNoisyDetected: case4.fired && case4.noisy[0]?.org_id === "org_kb_noisy",
    planTierPropagatedToNoisy: case1.noisy[0]?.plan_tier === "TRIAL",
    nullPlanTierSurvives: tinyOrgs[0].plan_tier === null,
  };

  const pass = Object.values(checks).every(Boolean);
  process.stdout.write(
    JSON.stringify({
      selfTest: true,
      pass,
      checks,
      case1: { fired: case1.fired, noisy: case1.noisy, medianCredits: case1.medianCredits },
    }) + "\n",
  );
  process.exit(pass ? 0 : 1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write(
    "DATABASE_URL is required (owner/migration role — BYPASSRLS, no tenant GUC needed)\n",
  );
  process.exit(2);
}

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
try {
  const featureCondition = featureScope
    ? sql`AND feature LIKE ${featureScope + "%"}`
    : sql``;
  const rows = await sql`
    SELECT
      a.org_id,
      (
        SELECT s.plan
        FROM subscriptions s
        WHERE s.org_id = a.org_id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) AS plan_tier,
      SUM(a.credits_milli)                       AS total_credits,
      COUNT(*)                                   AS request_count,
      mode() WITHIN GROUP (ORDER BY a.feature)   AS top_feature
    FROM ai_usage_logs a
    WHERE a.created_at > NOW() - (${windowHours} * INTERVAL '1 hour')
    ${featureCondition}
    GROUP BY a.org_id
    ORDER BY SUM(a.credits_milli) DESC
    LIMIT 200
  `;

  const result = evaluateUsage(rows);
  process.stdout.write(
    JSON.stringify({
      fired: result.fired,
      windowHours,
      featureScope: featureScope || "all",
      threshold: { multiplier, minOrgs },
      medianCredits: result.medianCredits ?? null,
      thresholdCredits: result.thresholdCredits ?? null,
      orgCount: result.orgCount,
      reason: result.reason ?? null,
      destination:
        "CONFIGURE_ME — wire exit-code 1 to your oncall system (PagerDuty, Slack webhook, etc.)",
      noisy: result.noisy ?? [],
      tierNote:
        "plan_tier is joined from subscriptions.plan (most recent row per org). Storage and index cost are not metered in the current schema and are not included.",
    }) + "\n",
  );
  process.exit(result.fired ? 1 : 0);
} finally {
  await sql.end();
}
