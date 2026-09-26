import { z } from "zod";

/**
 * HRM-15 shapes shared by every reporting-manager route (CONTRACT.md §4).
 *
 * Request schemas here are structural only. Rule violations — a top-level row
 * with a manager, a secondary duplicating the primary, a missing change reason —
 * are the canonical relationship service's to reject, because only it can answer
 * with the contract's error `code`; a Zod 400 carries none.
 */

export const managerStateSchema = z.enum(["active", "on-notice", "inactive", "exited"]);

export const managerRefSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  designation: z.string().nullable(),
  state: managerStateSchema,
});

export const relationshipTypeSchema = z.enum(["PRIMARY", "SECONDARY"]);

/** CONTRACT.md §1.1 — `hr_reporting_lines.source`. */
export const reportingLineSourceSchema = z.enum([
  "MANUAL",
  "MIGRATED",
  "ONBOARDING_SELECTED",
  "ONBOARDING_FALLBACK",
  "BULK_ONBOARDING",
  "STAGED_IMPORT",
  "EMPLOYEE_REQUEST",
  "BULK_REASSIGNMENT",
  "EMERGENCY_OVERRIDE",
  "EFFECTIVE_CHANGE",
]);

export const relationshipEntrySchema = z.object({
  lineId: z.number().int(),
  relationshipType: relationshipTypeSchema,
  label: z.string().nullable(),
  manager: managerRefSchema,
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  source: reportingLineSourceSchema,
  isFallback: z.boolean(),
  fallbackConfirmedAt: z.string().nullable(),
  recordedAt: z.string(),
  /** Null unless the caller holds hr:reporting-lines:manage or :review. */
  changeReason: z.string().nullable(),
});

export const managerResolutionSchema = z.enum(["SELECTED", "IN_FILE", "FALLBACK_CONFIGURED", "FALLBACK_UPLOADER"]);

export const effectiveDateSchema = z.iso.date();

export const secondaryManagerInputSchema = z
  .object({
    managerUserId: z.string().trim().min(1).max(128),
    label: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const managerCandidatesResponseSchema = z.object({ items: z.array(managerRefSchema) });

export const employeeUserIdParamsSchema = z.object({ employeeUserId: z.string().min(1).max(128) }).strict();
export const reportingManagerRequestIdParamsSchema = z.object({ requestId: z.string().uuid() }).strict();
export const reportingLineBulkJobIdParamsSchema = z.object({ jobId: z.string().uuid() }).strict();

export type ManagerRef = z.infer<typeof managerRefSchema>;
export type RelationshipEntry = z.infer<typeof relationshipEntrySchema>;
export type ReportingLineSource = z.infer<typeof reportingLineSourceSchema>;
export type ManagerResolution = z.infer<typeof managerResolutionSchema>;
export type SecondaryManagerInput = z.infer<typeof secondaryManagerInputSchema>;
