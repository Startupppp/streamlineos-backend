import { z } from "zod";

export const healthCheckSchema = z.object({
  status: z.literal("ok"),
});

export const versionSchema = z.object({
  commitSha: z.string().min(1).nullable(),
});

const dependencyStateSchema = z.enum(["up", "degraded", "down", "skipped"]);

const dependencyReportSchema = z.object({
  name: z.string(),
  state: dependencyStateSchema,
  required: z.boolean(),
  latencyMs: z.number(),
  detail: z.string().nullable(),
});

export const readinessSnapshotSchema = z.object({
  status: z.enum(["ready", "degraded", "unready"]),
  checkedAt: z.string(),
  ageMs: z.number(),
  cached: z.boolean(),
  dependencies: z.array(dependencyReportSchema),
});

export const workflowHealthSchema = z.object({
  status: z.enum(["ok", "stalled"]),
  due: z.number().int(),
  oldestDueSeconds: z.number().nullable(),
  overdueSchedules: z.number().int(),
  oldestOverdueScheduleSeconds: z.number().nullable(),
  leased: z.number().int(),
  retrying: z.number().int(),
  deadLettered: z.number().int(),
  cancelled: z.number().int(),
  organizations: z.number().int(),
  failedOrganizations: z.number().int(),
  hint: z.string().optional(),
});

const poolTelemetrySnapshotSchema = z.object({
  max: z.number().int(),
  waiting: z.number().int(),
  borrows: z.number().int(),
  inFlight: z.number().int(),
  maxWaitMs: z.number(),
  peakWaiting: z.number().int(),
  peakInFlight: z.number().int(),
  slowAcquires: z.number().int(),
  averageWaitMs: z.number(),
  failedAcquires: z.number().int(),
  saturationEvents: z.number().int(),
  lastSaturationAt: z.string().nullable(),
  p95WaitMs: z.number(),
  maxHeldMs: z.number(),
  averageHeldMs: z.number(),
  p95HeldMs: z.number(),
  longHolds: z.number().int(),
  maxIdleInTransactionMs: z.number(),
  p95IdleInTransactionMs: z.number(),
  idleInTransactionBorrows: z.number().int(),
  statementsPerBorrowMax: z.number().int(),
});

const seamSnapshotSchema = z.object({
  count: z.number().int(),
  p95Ms: z.number(),
});

const queryTelemetrySnapshotSchema = z.object({
  "db.guc.setup": seamSnapshotSchema,
  "db.query.execute": seamSnapshotSchema,
  rowsReturned: z.number().int(),
  slowQueries: z.number().int(),
  lockWaits: z.number().int(),
  deadlocks: z.number().int(),
  timeouts: z.number().int(),
  fingerprints: z.number().int(),
  fingerprintsDropped: z.number().int(),
});

const queryFingerprintStatSchema = z.object({
  id: z.string(),
  shape: z.string(),
  calls: z.number().int(),
  totalMs: z.number(),
  maxMs: z.number(),
  slowCalls: z.number().int(),
  rowsReturned: z.number().int(),
  errors: z.number().int(),
  lockWaits: z.number().int(),
  deadlocks: z.number().int(),
  timeouts: z.number().int(),
});

export const databasePoolHealthSchema = z.object({
  status: z.enum(["ok", "saturated"]),
  latencyMs: z.number(),
  endpoint: z.object({
    host: z.string(),
    pooled: z.boolean(),
    role: z.enum(["application", "owner"]),
  }),
  pool: poolTelemetrySnapshotSchema,
  queries: queryTelemetrySnapshotSchema,
  slowestFingerprints: z.array(queryFingerprintStatSchema),
});
