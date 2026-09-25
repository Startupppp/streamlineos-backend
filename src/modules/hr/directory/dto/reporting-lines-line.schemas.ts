import { z } from "zod";
import { managerCoverageReportSchema, reportingLineViewSchema } from "./reporting-lines-response.schemas";
import {
  effectiveDateSchema,
  managerRefSchema,
  relationshipEntrySchema,
  reportingLineSourceSchema,
  secondaryManagerInputSchema,
} from "./reporting-lines-shared.schemas";

/** CONTRACT.md §4.1–§4.7 and §4.13. Standalone until the routes are wired. */

export const fallbackOrderSchema = z.enum(["CONFIGURED_MANAGER_THEN_UPLOADER", "UPLOADER_THEN_CONFIGURED_MANAGER"]);

export const reportingManagerPolicySchema = z.object({
  maxSecondaryManagersPerEmployee: z.number().int().min(0).max(3),
  defaultPrimaryManager: managerRefSchema.nullable(),
  defaultPrimaryManagerEligible: z.boolean(),
  fallbackOrder: fallbackOrderSchema,
  requireReasonAfterChanges: z.number().int().min(1).max(10),
  allowTopLevelWithoutManager: z.boolean(),
  version: z.number().int(),
  updatedAt: z.string().nullable(),
  isConfigured: z.boolean(),
  actorQualifiesAsFallback: z.boolean(),
});

export const updateReportingManagerPolicySchema = z
  .object({
    maxSecondaryManagersPerEmployee: z.number().int().min(0).max(3).optional(),
    defaultPrimaryManagerUserId: z.string().trim().min(1).max(128).nullable().optional(),
    fallbackOrder: fallbackOrderSchema.optional(),
    requireReasonAfterChanges: z.number().int().min(1).max(10).optional(),
    allowTopLevelWithoutManager: z.boolean().optional(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();

/** Today's PRIMARY entry, kept for existing readers, plus the three fields §4.3 adds. */
const primaryHistoryEntrySchema = reportingLineViewSchema.shape.history.element.extend({
  source: reportingLineSourceSchema,
  isFallback: z.boolean(),
  relationshipType: z.literal("PRIMARY"),
});

export const reportingLineDetailSchema = reportingLineViewSchema.extend({
  current: primaryHistoryEntrySchema.nullable(),
  upcoming: z.array(primaryHistoryEntrySchema),
  history: z.array(primaryHistoryEntrySchema),
  secondary: z.array(relationshipEntrySchema),
  topLevel: z.object({ reason: z.string(), effectiveFrom: z.string() }).nullable(),
  primaryChangesLast24h: z.number().int(),
  changeThreshold: z.number().int(),
  maxSecondaryManagers: z.number().int(),
  pendingRequest: z
    .object({ requestId: z.string(), status: z.string(), createdAt: z.string() })
    .nullable(),
  permittedActions: z.object({ manage: z.boolean(), review: z.boolean(), override: z.boolean() }),
});

export const setReportingLineSchema = z
  .object({
    primaryManagerUserId: z.string().trim().min(1).max(128).nullable(),
    topLevelReason: z.string().trim().min(1).max(500).optional(),
    secondaryManagers: z.array(secondaryManagerInputSchema).max(3).optional(),
    effectiveFrom: effectiveDateSchema.optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
    emergency: z.boolean().optional(),
  })
  .strict();

export const setReportingLineResponseSchema = z.object({
  line: reportingLineDetailSchema,
  warnings: z.array(z.string()),
});

export const MANAGER_CANDIDATES_CAP = 20;

export const managerCandidatesQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    excludeUserId: z.string().trim().min(1).max(128).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .default(MANAGER_CANDIDATES_CAP)
      .transform((value) => Math.min(value, MANAGER_CANDIDATES_CAP)),
  })
  .strict();

export const managerCoverageDetailSchema = managerCoverageReportSchema.extend({
  summary: managerCoverageReportSchema.shape.summary.extend({
    topLevel: z.number().int(),
    fallback: z.number().int(),
    pendingReview: z.number().int(),
  }),
  policyMissing: z.boolean(),
  fallback: z.array(
    z.object({
      userId: z.string().nullable(),
      name: z.string().nullable(),
      managerUserId: z.string().nullable(),
      managerName: z.string().nullable(),
      effectiveFrom: z.string(),
    }),
  ),
  pendingReview: z.array(
    z.object({
      requestId: z.string(),
      userId: z.string().nullable(),
      name: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

export const myReportingLineSchema = z.object({
  primary: relationshipEntrySchema.nullable(),
  secondary: z.array(relationshipEntrySchema),
  topLevel: z.object({ effectiveFrom: z.string() }).nullable(),
});

export type ReportingManagerPolicy = z.infer<typeof reportingManagerPolicySchema>;
export type UpdateReportingManagerPolicyInput = z.infer<typeof updateReportingManagerPolicySchema>;
export type ReportingLineDetail = z.infer<typeof reportingLineDetailSchema>;
export type SetReportingLineInput = z.infer<typeof setReportingLineSchema>;
export type ManagerCandidatesQuery = z.infer<typeof managerCandidatesQuerySchema>;
export type ManagerCoverageDetail = z.infer<typeof managerCoverageDetailSchema>;
export type MyReportingLine = z.infer<typeof myReportingLineSchema>;
