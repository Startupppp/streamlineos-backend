import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

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
