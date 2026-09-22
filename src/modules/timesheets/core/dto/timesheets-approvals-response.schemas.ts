import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { approvalCandidateSchema } from "../../../directory/dto/approval-route.schemas";

export const timesheetApprovalRouteSchema = z.object({
  source: z.enum(["reporting_manager", "project_manager", "auto"]),
  rung: z.string().nullable(),
  approverUserId: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  assignedToUserId: z.string().nullable(),
  delegation: z.object({ fromUserId: z.string(), toUserId: z.string(), endsAt: z.string() }).nullable(),
  projectId: z.number().int().nullable(),
  explanation: z.string(),
  slaHours: z.number().int(),
  escalationRung: z.string().nullable(),
  escalatedFrom: z.object({ approverUserId: z.string().nullable(), rung: z.string().nullable(), at: z.string() }).nullable(),
});

export const periodApproverPreviewSchema = z.object({
  kind: z.enum(["auto", "routed", "unowned"]),
  approver: approvalCandidateSchema.nullable(),
  route: timesheetApprovalRouteSchema.nullable(),
  dueAt: z.string().nullable(),
  explanation: z.string(),
});
export type PeriodApproverPreview = z.infer<typeof periodApproverPreviewSchema>;

export const timesheetPeriodSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  totalHours: z.string(),
  billableHours: z.string(),
  nonBillableHours: z.string(),
  submittedAt: nullableWireDate(),
  approvedAt: nullableWireDate(),
  rejectedAt: nullableWireDate(),
  lockedAt: nullableWireDate(),
  currentApproverMembershipId: z.number().int().nullable(),
  approvalRoute: timesheetApprovalRouteSchema.nullable(),
  approvalDueAt: nullableWireDate(),
  approvalEscalatedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: z.object({
    membershipId: z.number().int().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }).optional(),
});

export const timesheetApprovalItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  totalHours: z.string(),
  billableHours: z.string(),
  nonBillableHours: z.string(),
  submittedAt: nullableWireDate(),
  approvedAt: nullableWireDate(),
  rejectedAt: nullableWireDate(),
  lockedAt: nullableWireDate(),
  currentApproverMembershipId: z.number().int().nullable(),
  approvalRoute: timesheetApprovalRouteSchema.nullable(),
  approvalDueAt: nullableWireDate(),
  approvalEscalatedAt: nullableWireDate(),
  approvedBy: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: z.object({
    membershipId: z.number().int().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
});

export const approvalsListResponseSchema = cursorPageSchema(timesheetApprovalItemSchema);

export const bulkApproveResponseSchema = z.object({
  approved: z.number().int(),
  skipped: z.number().int(),
});

export const bulkRejectResponseSchema = z.object({ rejected: z.number().int() });
