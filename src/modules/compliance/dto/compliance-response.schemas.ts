import { z } from "zod";

/**
 * The register as a customer reads it.
 *
 * `effectiveFrom` and `retiredAt` are already ISO strings on the wire:
 * `SubprocessorsService.list` calls `toISOString()` itself rather than handing
 * the timestamp columns through, so these are `z.string()` and not `wireDate()`.
 * A retired entry keeps its row, which is why `retiredAt` is nullable rather
 * than the entry being absent — a reviewer checking a past period needs to know
 * who processed their data then.
 */
export const subprocessorEntrySchema = z.object({
  name: z.string(),
  purpose: z.string(),
  location: z.string(),
  url: z.string().nullable(),
  effectiveFrom: z.string(),
  retiredAt: z.string().nullable(),
});

export const listSubprocessorsResponseSchema = z.object({
  data: z.array(subprocessorEntrySchema),
});

/** Both subscription routes answer with the act, not the row. */
export const subscribeResponseSchema = z.object({ subscribed: z.literal(true) });
export const unsubscribeResponseSchema = z.object({ unsubscribed: z.literal(true) });

/**
 * The filed record of a subject request — counts and completeness, never the
 * exported rows. `isComplete` is decoded from a text column, so anything that is
 * not the literal "true" reads as false.
 */
export const filedSubjectRequestSchema = z.object({
  subjectRequestId: z.string(),
  kind: z.string(),
  subjectEmail: z.string(),
  isComplete: z.boolean(),
  totalRecordsAffected: z.number().int(),
  requestedAt: z.string(),
  completedAt: z.string().nullable(),
  dueBy: z.string().nullable(),
});

export const listSubjectRequestsResponseSchema = z.object({
  data: z.array(filedSubjectRequestSchema),
});

const regionOutcomeSchema = z.object({
  region: z.string(),
  status: z.enum(["completed", "failed"]),
  recordsAffected: z.number().int(),
  at: z.string(),
  error: z.string().optional(),
});

/**
 * Every planned table reports, including the ones that could not be looked
 * inside — `absent` and `not-identifiable` are different answers from "no rows",
 * and collapsing them is how a gap becomes invisible.
 */
const tableOutcomeSchema = z.object({
  table: z.string(),
  disposition: z.enum(["erase", "retain", "undeclared"]),
  status: z.enum(["scanned", "absent", "not-identifiable"]),
  rowsMatched: z.number().int(),
  rowsErased: z.number().int(),
  truncated: z.boolean().optional(),
});

/**
 * One execution, across every configured region.
 *
 * `result.complete` is the fact — every region reported success — and
 * `mayReportComplete` is the decision, which is stricter. They are separate
 * fields because a partial result reads as completion to anyone who only sees
 * one of them.
 *
 * The export payload itself is deliberately not on this contract. `data` is
 * present only for an export and is shaped by whatever the plan matched, so
 * there is nothing truthful to declare for it; an undeclared key passes the
 * interceptor rather than being stripped.
 */
export const executeSubjectRequestResponseSchema = z.object({
  subjectRequestId: z.string(),
  result: z.object({
    kind: z.enum(["erasure", "export"]),
    subjectEmail: z.string(),
    regions: z.array(regionOutcomeSchema),
    complete: z.boolean(),
    totalRecordsAffected: z.number().int(),
    backupsExpireBy: z.string().nullable(),
  }),
  mayReportComplete: z.boolean(),
  failureSummary: z.string().nullable(),
  tables: z.record(z.string(), z.array(tableOutcomeSchema)),
  undeclared: z.array(z.string()),
  notIdentifiable: z.array(z.string()),
});
