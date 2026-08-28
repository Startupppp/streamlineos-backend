export const UNIT_COSTS = [
  {
    id: "per-active-org",
    label: "per active organization",
    denominatorPer: 1,
    source: "measured",
    countSql: `
      SELECT count(*)::bigint AS quantity
      FROM organizations o
      JOIN subscriptions s ON s.org_id = o.id
      WHERE s.status = 'ACTIVE'`,
    requiresOwnerRole: true,
    vendorCostSource: "neon",
    costNote: "Quantity from DB. Dollar cost per org = total cell monthly Neon spend / active org count. Set NEON_API_KEY + NEON_PROJECT_ID + NEON_COMPUTE_RATE_USD_PER_HOUR + NEON_STORAGE_RATE_USD_PER_GIB_MONTH to derive from real consumption.",
  },
  {
    id: "per-active-user",
    label: "per active user",
    denominatorPer: 1,
    source: "measured",
    countSql: `
      SELECT count(*)::bigint AS quantity
      FROM users
      WHERE deleted_at IS NULL`,
    requiresOwnerRole: true,
    vendorCostSource: "neon",
    costNote: "Quantity from DB. Dollar cost per user = total cell monthly Neon spend / active user count. Set NEON_API_KEY + NEON_PROJECT_ID + rate env vars to derive from real consumption.",
  },
  {
    id: "per-1k-requests",
    label: "per 1,000 requests",
    denominatorPer: 1_000,
    source: "unmeasured",
    requiredInput: "HTTP request count for this cell. Primary source: .load-driver-results.json written by the load driver (Lane B) with field requestCount:number and durationMs:number. Fallback: application request logs or an APM tool.",
  },
  {
    id: "per-1k-realtime-minutes",
    label: "per 1,000 realtime minutes",
    denominatorPer: 1_000,
    source: "unmeasured",
    vendorCostSource: "ably",
    requiredInput: "Channel-minutes for this cell's Ably app. Set ABLY_API_KEY to fetch from the Ably REST stats API (GET /stats?unit=month). Quantity is channelMean * intervalMinutes or channelPeak * intervalMinutes.",
  },
  {
    id: "per-gb-stored",
    label: "per GB stored",
    denominatorPer: 1,
    source: "measured",
    countSql: `SELECT round(pg_database_size(current_database())::numeric / 1073741824, 4) AS quantity`,
    requiresOwnerRole: false,
    vendorCostSource: "neon",
    costNote: "DB storage from pg_database_size(). Set NEON_API_KEY + NEON_PROJECT_ID + NEON_STORAGE_RATE_USD_PER_GIB_MONTH to derive dollar cost from real consumption. R2 file storage: set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.",
  },
  {
    id: "per-million-chunks",
    label: "per million indexed chunks",
    denominatorPer: 1_000_000,
    source: "measured",
    countSql: `SELECT count(*)::bigint AS quantity FROM kb_article_chunks`,
    requiresOwnerRole: true,
    vendorCostSource: "neon-and-r2",
    costNote: "Chunk count from kb_article_chunks. Dollar cost requires Neon storage rate (vector HNSW index) + R2 storage rate (source files). Set NEON_API_KEY + NEON_PROJECT_ID + CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.",
  },
  {
    id: "per-million-events",
    label: "per million outbox events",
    denominatorPer: 1_000_000,
    source: "measured",
    countSql: `SELECT count(*)::bigint AS quantity FROM outbox_events`,
    requiresOwnerRole: true,
    vendorCostSource: "neon",
    costNote: "Event count from outbox_events (all tenants). Dollar cost requires Neon compute + storage spend. Set NEON_API_KEY + NEON_PROJECT_ID + rate env vars.",
  },
  {
    id: "per-notification",
    label: "per notification delivered",
    denominatorPer: 1,
    source: "measured",
    countSql: `SELECT count(*)::bigint AS quantity FROM notifications WHERE deleted_at IS NULL`,
    requiresOwnerRole: true,
    vendorCostSource: "resend",
    costNote: "Notification count from DB. Dollar cost requires RESEND_API_KEY (key presence confirms vendor; Resend has no billing cost API — apply the per-email rate from your Resend invoice to the DB count).",
  },
  {
    id: "per-ai-token",
    label: "per AI token",
    denominatorPer: 1,
    source: "ledger",
    countSql: `
      SELECT
        sum(total_tokens)::bigint AS quantity,
        sum(credits_milli)::bigint AS credits_milli_total,
        round(sum(estimated_cost_usd::numeric), 6) AS cost_usd
      FROM ai_usage_logs`,
    requiresOwnerRole: true,
    ledgerNote: "Cost from the milli-credit ledger (ai_usage_logs.credits_milli). Reuses computeTokenCharge settlement; no separate accounting path.",
  },
];

export function canContributeQuantity(unit) {
  return unit.source !== "unmeasured";
}

export function detectAnomalousTenants(sampleCosts, stdDevThreshold) {
  const threshold = stdDevThreshold ?? 2.5;
  if (sampleCosts.length < 3)
    return { status: "refused", reason: `${sampleCosts.length} sample(s); need at least 3 for anomaly detection.` };

  const values = sampleCosts.map((s) => s.cost);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, c) => s + (c - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev < 1e-9)
    return { status: "ok", anomalous: [], message: "All sampled costs are equal; no anomaly." };

  const anomalous = sampleCosts.filter((s) => (s.cost - mean) / stdDev > threshold);
  return { status: "ok", anomalous, mean, stdDev };
}
