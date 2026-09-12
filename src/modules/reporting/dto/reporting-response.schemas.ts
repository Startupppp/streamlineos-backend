import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

/**
 * What the reporting surface returns.
 *
 * `queryDescription` is the compiler's own `QueryDescription` — a recursive
 * select/filter/group tree. It is declared as the stored blob rather than
 * re-modelled here: the vocabulary lives in `compiler/query-description.ts`, and
 * a second copy of it in a response contract is a copy that drifts. The rows
 * carrying it say plenty besides, so the contract is not vacuous.
 */
const queryDescriptionSchema = z.record(z.string(), z.unknown());

const fieldTypeSchema = z.enum(["text", "enum", "number", "boolean", "timestamp", "date"]);

/** `CompiledColumn` — the generated alias and what the caller asked for. */
const compiledColumnSchema = z.object({
  alias: z.string(),
  type: fieldTypeSchema,
});

const reportDefinitionRowSchema = z.object({
  reportDefinitionId: z.string(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sourceKey: z.string(),
  queryDescription: queryDescriptionSchema,
  createdByUserId: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const reportDefinitionResponseSchema = reportDefinitionRowSchema;

/**
 * `listDefinitions` — a bare array, offset-paged by the query.
 *
 * `createdByName` comes off a projected LEFT JOIN to `users`, so it is null for
 * an author who has left rather than the report disappearing from the list.
 */
export const listReportDefinitionsResponseSchema = z.array(
  z.object({
    reportDefinitionId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    sourceKey: z.string(),
    createdByUserId: z.string().nullable(),
    createdByName: z.string().nullable(),
    createdAt: wireDate(),
    updatedAt: wireDate(),
  }),
);

/** `deleteDefinition` — a hard delete; a miss throws. */
export const deleteReportDefinitionResponseSchema = z.object({ deleted: z.literal(true) });

/** `describeSources` — already filtered to what this caller could run. */
export const reportSourcesResponseSchema = z.array(
  z.object({
    key: z.string(),
    label: z.string(),
    fields: z.array(
      z.object({ name: z.string(), label: z.string(), type: fieldTypeSchema }),
    ),
    relations: z.array(
      z.object({
        name: z.string(),
        fields: z.array(
          z.object({ name: z.string(), label: z.string(), type: fieldTypeSchema }),
        ),
      }),
    ),
  }),
);

/**
 * `explain` — the statement, and the count of what would have been bound.
 *
 * The parameter VALUES are deliberately absent: the statement is content-free,
 * and echoing the values into a body that may be logged would put tenant data
 * where the design took care to keep it out.
 */
export const explainReportResponseSchema = z.object({
  source: z.string(),
  sql: z.string(),
  parameterCount: z.number().int(),
  columns: z.array(compiledColumnSchema),
});

/**
 * `ReportResult` — what a run returns.
 *
 * A row's keys are the compiler's generated aliases and its values come back
 * from the driver untyped, so a row can only be described as a record;
 * `columns` is what labels it. `truncated` is stated because the caller cannot
 * tell a full page from the end of the answer.
 */
export const runReportResponseSchema = z.object({
  columns: z.array(compiledColumnSchema),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
  truncated: z.boolean(),
});

/**
 * Phase 5 ticket 15 — what `proposeFromQuestion` returns.
 *
 * A discriminated union, matching the internal shape exactly: `accepted`
 * carries the proposal AND its compile preview (never rows — the same
 * `explain` shape `POST /explain` returns), so a client can render both the
 * description and its SQL preview without a second round trip; a refusal
 * carries only a reason, whether that refusal came from the model itself or
 * from the proposal failing to compile.
 */
export const nlProposeResponseSchema = z.discriminatedUnion("accepted", [
  z.object({
    accepted: z.literal(true),
    description: z.record(z.string(), z.unknown()),
    explanation: z.string(),
    preview: explainReportResponseSchema,
  }),
  z.object({ accepted: z.literal(false), reason: z.string() }),
]);

/** `listRuns` — the audit read. The statements carry no tenant values. */
export const listReportRunsResponseSchema = z.array(
  z.object({
    reportRunId: z.string(),
    /** Null for an ad-hoc run. */
    reportDefinitionId: z.string().nullable(),
    sourceKey: z.string(),
    compiledSql: z.string(),
    parameterCount: z.number().int(),
    rowCount: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    ranByUserId: z.string().nullable(),
    ranByName: z.string().nullable(),
    createdAt: wireDate(),
  }),
);

/**
 * A schedule with its recipients folded in.
 *
 * The recipients are their own table — an address has to be removable on its own
 * — and every read here resolves them, so the shape is the same on the list, the
 * single read and both writes.
 */
export const reportScheduleResponseSchema = z.object({
  reportScheduleId: z.string(),
  organizationId: z.string(),
  reportDefinitionId: z.string(),
  cadence: z.string(),
  hourOfDay: z.number().int(),
  dayOfWeek: z.number().int(),
  dayOfMonth: z.number().int(),
  /** Whose permissions and DataScope the unattended run executes under. */
  runAsUserId: z.string(),
  enabled: z.boolean(),
  runCount: z.number().int(),
  nextRunAt: wireDate(),
  lastRunAt: nullableWireDate(),
  /** Why the last attempt failed, so a silently dead schedule is visible. */
  lastError: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  recipients: z.array(z.string()),
});

export const listReportSchedulesResponseSchema = z.array(reportScheduleResponseSchema);

/** `remove` — the recipients go with it through the composite FK's cascade. */
export const deleteReportScheduleResponseSchema = z.object({ deleted: z.literal(true) });
