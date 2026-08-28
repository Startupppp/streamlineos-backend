export const ENVELOPE = {
  registeredAccounts: 20_000_000,
  organizations: 1_000_000,
  dailyActiveUsers: 2_000_000,
  peakSessions: 250_000,
  realtimeConnections: 100_000,
  largestOrgMembers: 100_000,
  sustainedRps: 50_000,
  burstRps: 100_000,
  burstDurationMinutes: 10,
  asyncEventsPerMinute: 1_000_000,
  singleBroadcastRecipients: 100_000,
  knowledgeChunks: 1_000_000_000,
};

const CELL_DIVISOR = 1_000;

export const CELL_SHARE = {
  divisor: CELL_DIVISOR,
  organizations: Math.floor(ENVELOPE.organizations / CELL_DIVISOR),
  largestOrgMembers: ENVELOPE.largestOrgMembers,
  dailyActiveUsers: Math.floor(ENVELOPE.dailyActiveUsers / CELL_DIVISOR),
  peakSessions: Math.floor(ENVELOPE.peakSessions / CELL_DIVISOR),
  realtimeConnections: Math.floor(ENVELOPE.realtimeConnections / CELL_DIVISOR),
  sustainedRps: Math.floor(ENVELOPE.sustainedRps / CELL_DIVISOR),
  burstRps: Math.floor(ENVELOPE.burstRps / CELL_DIVISOR),
  asyncEventsPerMinute: Math.floor(ENVELOPE.asyncEventsPerMinute / CELL_DIVISOR),
  singleBroadcastRecipients: ENVELOPE.singleBroadcastRecipients,
  knowledgeChunks: Math.floor(ENVELOPE.knowledgeChunks / CELL_DIVISOR),
};

const NON_EXTRAPOLABLE = new Set([
  "realtimeConnections",
  "burstDurationMinutes",
  "knowledgeChunks",
  "singleBroadcastRecipients",
]);

export const EXTRAPOLATION_NOTES = {
  registeredAccounts: "linear: each cell holds a proportional slice of registered accounts",
  organizations: "linear: organizations are placed deterministically per cell",
  dailyActiveUsers: "linear: DAU distributes proportionally to org placement",
  peakSessions: "linear: peak sessions scale with DAU",
  realtimeConnections: "not-extrapolable: depends on Ably/realtime adapter capacity and per-user connection ratios, not DB row counts",
  largestOrgMembers: "sub-linear: tenant-scoped index cost is roughly flat in tenant count once the index is covering; the per-tenant query plan does not change with cell occupancy",
  sustainedRps: "linear: request volume scales with active user count per cell",
  burstRps: "linear: burst capacity scales with sustained capacity",
  asyncEventsPerMinute: "linear: event volume scales with active user count",
  singleBroadcastRecipients: "not-extrapolable: broadcast is a per-org operation whose worst case (100k recipients) is seeded at full size; scaling cell count does not change the per-broadcast cost",
  knowledgeChunks: "not-extrapolable: depends on per-org content volume and vector index capacity; not derivable from user-count scaling",
  burstDurationMinutes: "not-extrapolable: a duration is not a count; no row-scaling formula applies",
};

export function extrapolate(measured, dimension) {
  if (!(dimension in EXTRAPOLATION_NOTES))
    throw new Error(`Unknown dimension: ${dimension}`);
  if (NON_EXTRAPOLABLE.has(dimension))
    throw new Error(`${dimension} is not extrapolable: ${EXTRAPOLATION_NOTES[dimension]}`);
  return measured * CELL_DIVISOR;
}

export const LATENCY_OBJECTIVES = [
  { name: "authenticated-interactive-availability", target: 99.95, unit: "% monthly per cell" },
  { name: "cross-org-data-exposure", target: 0, unit: "tolerated incidents" },
  { name: "p99-in-process-authorization", target: 100, unit: "µs CPU time without I/O" },
  { name: "p95-redis-operation", target: 2, unit: "ms including network" },
  { name: "p95-simple-db-roundtrip", target: 20, unit: "ms including pool wait and GUC setup" },
  { name: "p95-complex-db-read", target: 50, unit: "ms" },
  { name: "p95-browser-cached-read", target: 150, unit: "ms same-region reference device" },
  { name: "p75-first-useful-view", target: 1_000, unit: "ms reference device and network" },
  { name: "p95-transactional-write", target: 500, unit: "ms excluding declared async work" },
  { name: "permission-revocation-explicit", target: 5_000, unit: "ms" },
  { name: "durable-event-loss-after-ack", target: 0, unit: "events" },
  { name: "node-failure-committed-loss", target: 0, unit: "transactions" },
  { name: "regional-rpo", target: 5, unit: "minutes" },
  { name: "cell-rto", target: 60, unit: "minutes" },
];
