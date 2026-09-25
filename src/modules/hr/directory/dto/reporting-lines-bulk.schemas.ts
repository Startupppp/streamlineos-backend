import { z } from "zod";
import { canonicalEmailSchema } from "../../../users/dto/users.schemas";
import { effectiveDateSchema, managerRefSchema, managerResolutionSchema } from "./reporting-lines-shared.schemas";

/**
 * CONTRACT.md §4.17–§4.21. Standalone until the routes are wired: the bulk
 * onboarding row DTO itself (§4.20) still lives in `hr-directory.schemas.ts`
 * and changes there only once the canonical services are published.
 */

export const BULK_REASSIGNMENT_ROW_CAP = 500;
export const BULK_JOB_ROWS_PAGE_CAP = 100;

const jobReasonSchema = z.string().trim().min(10).max(1000);

export const bulkReassignmentRowSchema = z
  .object({
    employeeEmail: canonicalEmailSchema,
    primaryManagerEmail: canonicalEmailSchema.optional(),
    secondaryManagerEmail1: canonicalEmailSchema.optional(),
    secondaryManagerEmail2: canonicalEmailSchema.optional(),
    secondaryManagerEmail3: canonicalEmailSchema.optional(),
    effectiveFrom: effectiveDateSchema.optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const createBulkJobFromRowsSchema = z
  .object({
    jobReason: jobReasonSchema,
    effectiveFrom: effectiveDateSchema.optional(),
    rows: z.array(bulkReassignmentRowSchema).min(1).max(BULK_REASSIGNMENT_ROW_CAP),
  })
  .strict();

export const createBulkJobFromSelectionSchema = z
  .object({
    jobReason: jobReasonSchema,
    employeeUserIds: z.array(z.string().trim().min(1).max(128)).min(1).max(BULK_REASSIGNMENT_ROW_CAP),
    primaryManagerUserId: z.string().trim().min(1).max(128),
    effectiveFrom: effectiveDateSchema.optional(),
  })
  .strict();

export const createBulkJobSchema = z.union([createBulkJobFromRowsSchema, createBulkJobFromSelectionSchema]);

export const commitBulkJobSchema = z
  .object({
    confirmationPhrase: z.string().trim().max(64).optional(),
    rowReasons: z
      .array(
        z
          .object({
            rowNumber: z.number().int().min(1).max(BULK_REASSIGNMENT_ROW_CAP),
            reason: z.string().trim().min(10).max(1000),
          })
          .strict(),
      )
      .max(BULK_REASSIGNMENT_ROW_CAP)
      .optional(),
  })
  .strict();

export const listBulkJobsSchema = z
  .object({ cursor: z.string().trim().min(1).max(2048).optional() })
  .strict();

export const getBulkJobSchema = z
  .object({ rowCursor: z.string().trim().min(1).max(2048).optional() })
  .strict();

export const bulkJobStatusSchema = z.enum(["PREVIEWED", "COMMITTING", "COMMITTED", "FAILED", "EXPIRED"]);
export const bulkJobRowStatusSchema = z.enum(["READY", "WARNING", "ERROR", "SKIPPED", "COMMITTED", "FAILED"]);

export const bulkJobRowSchema = z.object({
  rowNumber: z.number().int(),
  employeeEmail: z.string(),
  employee: managerRefSchema.nullable(),
  currentPrimary: managerRefSchema.nullable(),
  requestedPrimary: managerRefSchema.nullable(),
  secondaryChanges: z.array(z.string()),
  changesLast24h: z.number().int(),
  requiresRowReason: z.boolean(),
  status: bulkJobRowStatusSchema,
  codes: z.array(z.string()),
  message: z.string().nullable(),
});

const bulkJobSummaryFields = {
  jobId: z.string(),
  status: bulkJobStatusSchema,
  jobReason: z.string(),
  rowCount: z.number().int(),
  readyCount: z.number().int(),
  warningCount: z.number().int(),
  errorCount: z.number().int(),
  committedCount: z.number().int(),
  requiresConfirmation: z.boolean(),
  confirmationPhrase: z.string().nullable(),
  createdAt: z.string(),
  committedAt: z.string().nullable(),
};

export const bulkJobSchema = z.object({
  ...bulkJobSummaryFields,
  rows: z.array(bulkJobRowSchema),
  nextRowCursor: z.string().nullable(),
});

/** §4.19 names `BulkJob` for the list too; a list of jobs cannot be one job, so items omit rows. */
export const bulkJobPageSchema = z.object({
  items: z.array(z.object(bulkJobSummaryFields)),
  nextCursor: z.string().nullable(),
});

export const bulkOnboardRowStatusSchema = z.enum(["READY", "WARNING", "ERROR", "SKIPPED"]);

export const onboardingPrimaryManagerSchema = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  email: z.string(),
  resolution: managerResolutionSchema,
});

export const bulkOnboardPreviewSchema = z.object({
  rows: z.array(
    z.object({
      row: z.number().int(),
      email: z.string(),
      status: bulkOnboardRowStatusSchema,
      codes: z.array(z.string()),
      messages: z.array(z.string()),
      primaryManager: onboardingPrimaryManagerSchema.nullable(),
      secondaryManagers: z.array(z.object({ name: z.string(), email: z.string() })),
      dependsOnRow: z.number().int().nullable(),
    }),
  ),
  counts: z.object({
    ready: z.number().int(),
    warning: z.number().int(),
    error: z.number().int(),
    skipped: z.number().int(),
  }),
});

export const bulkOnboardCommitResultSchema = z.object({
  total: z.number().int(),
  created: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
  results: z.array(
    z.object({
      row: z.number().int(),
      email: z.string(),
      success: z.boolean(),
      userId: z.string().optional(),
      error: z.string().optional(),
      status: bulkOnboardRowStatusSchema,
      codes: z.array(z.string()),
      primaryManager: onboardingPrimaryManagerSchema.nullable(),
    }),
  ),
});

/** §4.21 — `resolution` is present only when the caller holds hr:employees:view. */
export const onboardPrimaryManagerSchema = z.object({
  userId: z.string(),
  name: z.string(),
  resolution: managerResolutionSchema.optional(),
});

export type CreateBulkJobInput = z.infer<typeof createBulkJobSchema>;
export type CommitBulkJobInput = z.infer<typeof commitBulkJobSchema>;
export type ListBulkJobsInput = z.infer<typeof listBulkJobsSchema>;
export type GetBulkJobInput = z.infer<typeof getBulkJobSchema>;
export type BulkJob = z.infer<typeof bulkJobSchema>;
export type BulkJobRow = z.infer<typeof bulkJobRowSchema>;
export type BulkOnboardPreview = z.infer<typeof bulkOnboardPreviewSchema>;
export type BulkOnboardCommitResult = z.infer<typeof bulkOnboardCommitResultSchema>;
export type OnboardPrimaryManager = z.infer<typeof onboardPrimaryManagerSchema>;
