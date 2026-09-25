import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { effectiveDateSchema, managerRefSchema } from "./reporting-lines-shared.schemas";

/** CONTRACT.md §4.8–§4.12 and §4.14–§4.16. Standalone until the routes are wired. */

export const reportingManagerRequestStatusSchema = z.enum([
  "PENDING",
  "MORE_INFO_REQUIRED",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
]);

const employeeReasonSchema = z.string().trim().min(20).max(1000);

export const createReportingManagerRequestSchema = z
  .object({
    reason: employeeReasonSchema,
    suggestedManagerUserId: z.string().trim().min(1).max(128).optional(),
    requestedEffectiveFrom: effectiveDateSchema.optional(),
  })
  .strict();

export const respondReportingManagerRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();

export const listMyReportingManagerRequestsSchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(20),
  })
  .strict();

export const myManagerCandidatesQuerySchema = z.object({ q: z.string().trim().max(100).optional() }).strict();

export const listReportingManagerRequestsSchema = z
  .object({
    status: reportingManagerRequestStatusSchema.optional(),
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(20),
  })
  .strict();

export const reviewReportingManagerRequestSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "CANCEL_DUPLICATE", "REQUEST_INFO"]),
    managerUserId: z.string().trim().min(1).max(128).optional(),
    effectiveFrom: effectiveDateSchema.optional(),
    reviewReason: z.string().trim().min(1).max(1000),
  })
  .strict();

export const myReportingManagerRequestSchema = z.object({
  requestId: z.string(),
  status: reportingManagerRequestStatusSchema,
  employeeReason: z.string(),
  suggestedManager: managerRefSchema.nullable(),
  requestedEffectiveFrom: z.string().nullable(),
  reviewReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
});

export const myReportingManagerRequestPageSchema = z.object({
  items: z.array(myReportingManagerRequestSchema),
  nextCursor: z.string().nullable(),
});

export const hrReportingManagerRequestSchema = myReportingManagerRequestSchema.extend({
  employee: managerRefSchema,
  currentManager: managerRefSchema.nullable(),
});

export const hrReportingManagerRequestPageSchema = z.object({
  items: z.array(hrReportingManagerRequestSchema),
  nextCursor: z.string().nullable(),
});

export const reviewReportingManagerRequestResponseSchema = z.object({
  request: hrReportingManagerRequestSchema,
  warnings: z.array(z.string()),
});

export type ReportingManagerRequestStatus = z.infer<typeof reportingManagerRequestStatusSchema>;
export type CreateReportingManagerRequestInput = z.infer<typeof createReportingManagerRequestSchema>;
export type RespondReportingManagerRequestInput = z.infer<typeof respondReportingManagerRequestSchema>;
export type ListMyReportingManagerRequestsInput = z.infer<typeof listMyReportingManagerRequestsSchema>;
export type MyManagerCandidatesQuery = z.infer<typeof myManagerCandidatesQuerySchema>;
export type ListReportingManagerRequestsInput = z.infer<typeof listReportingManagerRequestsSchema>;
export type ReviewReportingManagerRequestInput = z.infer<typeof reviewReportingManagerRequestSchema>;
export type MyReportingManagerRequest = z.infer<typeof myReportingManagerRequestSchema>;
export type HrReportingManagerRequest = z.infer<typeof hrReportingManagerRequestSchema>;
