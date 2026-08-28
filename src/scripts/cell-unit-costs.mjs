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
    costNote: "Quantity from DB. Dollar cost per org = total cell monthly spend / active org count; provide the cell's Neon invoice.",
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
    costNote: "Quantity from DB. Dollar cost per user = total cell monthly spend / active user count; provide the cell's Neon invoice.",
  },
  {
    id: "per-1k-requests",
    label: "per 1,000 requests",
    denominatorPer: 1_000,
    source: "unmeasured",
    requiredInput: "HTTP request count for this cell — collected from application request logs or an APM tool, not stored in the database.",
  },
  {
    id: "per-1k-realtime-minutes",
    label: "per 1,000 realtime minutes",
    denominatorPer: 1_000,
    source: "unmeasured",
    requiredInput: "Channel-minutes from the Ably dashboard or billing API for this cell's Ably app — not stored in the database.",
  },
  {
    id: "per-gb-stored",
    label: "per GB stored",
    denominatorPer: 1,
    source: "measured",
    countSql: `SELECT round(pg_database_size(current_database())::numeric / 1073741824, 4) AS quantity`,
    requiresOwnerRole: false,
    costNote: "Storage volume measured from pg_database_size(). Dollar cost per GB requires the Neon invoice (GB-month rate for this plan).",
  },
  {
    id: "per-million-chunks",
    label: "per million indexed chunks",
    denominatorPer: 1_000_000,
    source: "measured",
    countSql: `SELECT count(*)::bigint AS quantity FROM kb_article_chunks`,
    requiresOwnerRole: true,
    costNote: "Chunk count from kb_article_chunks. Dollar cost per chunk requires embedding + HNSW storage spend (not in DB).",
  },
  {
    id: "per-million-events",
    label: "per million outbox events",
    denominatorPer: 1_000_000,
    source: "measured",
    countSql: `SELECT count(*)::bigint AS quantity FROM outbox_events`,
    requiresOwnerRole: true,
    costNote: "Event count from outbox_events (all tenants). Dollar cost per event requires the cell's infrastructure spend.",
  },
  {
    id: "per-notification",
    label: "per notification delivered",
    denominatorPer: 1,
    source: "measured",
    countSql: `SELECT count(*)::bigint AS quantity FROM notifications WHERE deleted_at IS NULL`,
    requiresOwnerRole: true,
    costNote: "Notification count from DB. Dollar cost per notification requires email delivery spend (e.g. Resend or SES invoice).",
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
