export const ADMISSION_THRESHOLD = 0.6;

export const MIN_SAMPLE_SPACING_MS = 86_400_000;

export const CEILING_SOURCES = ["measured", "vendor-declared", "operational-judgment"];

export function filterWellSpacedSamples(entries) {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const kept = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].ts - kept[kept.length - 1].ts >= MIN_SAMPLE_SPACING_MS)
      kept.push(sorted[i]);
  }
  return kept;
}

export const CAPACITY_BUDGETS = [
  {
    id: "connections",
    resource: "connections",
    unit: "connections",
    usageSql: `SELECT count(*)::int AS used FROM pg_stat_activity WHERE state IS NOT NULL`,
    ceilingSql: `SELECT current_setting('max_connections')::int AS "limit"`,
    ceilingSource: "measured",
    admissionGating: true,
    requiresOwnerRole: true,
    note: "Active backends vs max_connections. Full visibility requires pg_monitor or owner role; app role sees only its own session.",
  },
  {
    id: "database-size",
    resource: "database-size",
    unit: "bytes",
    usageSql: `SELECT pg_database_size(current_database())::bigint AS used`,
    ceilingSource: "vendor-declared",
    ceilingValue: 3_221_225_472,
    admissionGating: true,
    requiresOwnerRole: false,
    note: "Database size vs vendor plan storage limit. Default 3 GiB = Neon Free plan. Override with CELL_STORAGE_LIMIT_BYTES.",
  },
  {
    id: "table-bloat",
    resource: "table-bloat",
    unit: "dead-row fraction",
    usageSql: `
      SELECT CASE WHEN (sum(n_live_tup) + sum(n_dead_tup)) = 0 THEN 0
                  ELSE sum(n_dead_tup)::float / (sum(n_live_tup) + sum(n_dead_tup))
             END AS used
      FROM pg_stat_user_tables`,
    ceilingSource: "operational-judgment",
    ceilingValue: 0.30,
    admissionGating: true,
    requiresOwnerRole: false,
    note: "Aggregate dead-row fraction across all user tables. 30% is the autovacuum_vacuum_scale_factor default; IOPS pressure becomes measurable at that level. No vendor declares it.",
  },
  {
    id: "index-size-vs-buffers",
    resource: "index-size-vs-buffers",
    unit: "bytes",
    usageSql: `
      SELECT coalesce(
        (SELECT sum(pg_indexes_size(c.oid))::bigint
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
           AND c.relkind = 'r'),
        0
      ) AS used`,
    ceilingSql: `SELECT setting::bigint * 8192 AS "limit" FROM pg_settings WHERE name = 'shared_buffers'`,
    ceilingSource: "measured",
    admissionGating: false,
    requiresOwnerRole: false,
    note: "Total user-table index footprint vs shared_buffers. ADVISORY, never admission-gating: a working set larger than the buffer pool is ordinary for any database of size and has no upper bound, so gating on it would close every cell permanently. It is a cache-pressure signal to investigate, not a capacity ceiling.",
  },
  {
    id: "outbox-queue-depth",
    resource: "outbox-queue-depth",
    unit: "events",
    usageSql: `SELECT count(*)::int AS used FROM outbox_events WHERE delivery_state IN ('PENDING', 'IN_FLIGHT')`,
    ceilingSource: "operational-judgment",
    ceilingValue: 10_000,
    admissionGating: true,
    requiresOwnerRole: true,
    note: "Pending and in-flight outbox events across all tenants. Requires owner role (cross-tenant RLS barrier). Ceiling of 10,000 is operational judgment; no external reference establishes it.",
  },
];

export function validateCapacityBudgets(budgets) {
  const errors = [];
  for (let i = 0; i < budgets.length; i++) {
    const b = budgets[i];
    const tag = `budget[${i}]${typeof b?.id === "string" ? ` "${b.id}"` : ""}`;
    if (!b || typeof b !== "object") { errors.push(`${tag}: must be an object`); continue; }
    if (typeof b.id !== "string" || !b.id) errors.push(`${tag}: id must be a non-empty string`);
    if (typeof b.resource !== "string" || !b.resource) errors.push(`${tag}: resource must be a non-empty string`);
    if (typeof b.unit !== "string") errors.push(`${tag}: unit must be a string`);
    if (typeof b.usageSql !== "string" || !b.usageSql.trim()) errors.push(`${tag}: usageSql must be a non-empty string`);
    const hasCeiling = b.ceilingSql != null || b.ceilingValue != null;
    if (!hasCeiling) errors.push(`${tag}: one of ceilingSql or ceilingValue must be provided`);
    if (!CEILING_SOURCES.includes(b.ceilingSource))
      errors.push(`${tag}: ceilingSource must be one of ${CEILING_SOURCES.join(", ")}`);
    if (typeof b.admissionGating !== "boolean")
      errors.push(`${tag}: admissionGating must be a boolean — a resource with no real ceiling must not gate admission`);
    if (typeof b.requiresOwnerRole !== "boolean") errors.push(`${tag}: requiresOwnerRole must be a boolean`);
  }
  return errors;
}

export function identifyLimitingResource(measurements) {
  const gating = measurements.filter((m) => m.admissionGating !== false);
  if (gating.length === 0) return null;
  return gating.reduce((best, m) => (m.ratio > best.ratio ? m : best));
}

export function advisoryResources(measurements) {
  return measurements.filter((m) => m.admissionGating === false);
}

export function checkAdmission(ratio) {
  return ratio < ADMISSION_THRESHOLD;
}

export function forecastSaturation(historyEntries, resourceId) {
  const relevant = historyEntries.filter(
    (h) => !h.duringBulkLoad && h.resources[resourceId] != null && h.resources[resourceId].limit > 0,
  );
  const spacedRaw = filterWellSpacedSamples(relevant);

  if (spacedRaw.length < 3) {
    const spacingDays = Math.round(MIN_SAMPLE_SPACING_MS / 86_400_000);
    return {
      status: "refused",
      reason: `${spacedRaw.length} well-spaced sample(s) of ${relevant.length} total; need 3 samples each ≥${spacingDays}d apart. Run with --record-only on a daily schedule to accumulate them.`,
      wellSpaced: spacedRaw.length,
      total: relevant.length,
      needed: 3,
    };
  }

  const points = spacedRaw
    .map((h) => ({ t: h.ts, ratio: h.resources[resourceId].used / h.resources[resourceId].limit }))
    .sort((a, b) => a.t - b.t);

  const n = points.length;
  const tMean = points.reduce((s, p) => s + p.t, 0) / n;
  const rMean = points.reduce((s, p) => s + p.ratio, 0) / n;
  const num = points.reduce((s, p) => s + (p.t - tMean) * (p.ratio - rMean), 0);
  const den = points.reduce((s, p) => s + (p.t - tMean) ** 2, 0);

  if (den === 0)
    return { status: "refused", reason: "All history entries share the same timestamp; cannot compute trend." };

  const slope = num / den;
  const intercept = rMean - slope * tMean;

  const FLAT_MS_THRESHOLD = 1e-12;
  if (Math.abs(slope) < FLAT_MS_THRESHOLD)
    return { status: "refused", reason: "Trend is flat (< 0.003% per day); saturation timing cannot be estimated." };

  if (slope <= 0)
    return { status: "decreasing", reason: "Usage ratio is declining; no saturation pressure detected." };

  const tSaturate = (ADMISSION_THRESHOLD - intercept) / slope;
  const msFromNow = tSaturate - Date.now();

  if (msFromNow <= 0)
    return { status: "refused", reason: "Extrapolated saturation is in the past; measurement cadence may be too low or trend has changed." };

  return { status: "forecast", daysUntilThreshold: Math.round(msFromNow / 86_400_000) };
}
