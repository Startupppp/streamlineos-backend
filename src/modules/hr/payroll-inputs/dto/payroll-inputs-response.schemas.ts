import { z } from "zod";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const payrollPeriodRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  periodKey: z.string(),
  status: z.string(),
  cutoffDate: z.string().nullable(),
  builtAt: nullableWireDate(),
  lockedAt: nullableWireDate(),
  lockedBy: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const payrollPeriodListSchema = cursorPageSchema(payrollPeriodRowSchema);

export const payrollPeriodLockedSchema = payrollPeriodRowSchema.extend({
  freeze: z.record(z.string(), z.unknown()),
  immutable: z.boolean(),
  contract: z.string(),
});

const payrollSnapshotItemSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  section: z.string(),
  payload: z.unknown(),
  sourceRefs: z.unknown().nullable(),
  createdAt: wireDate(),
  userName: z.string().nullable(),
  userFirstName: z.string().nullable(),
  userLastName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

export const payrollSnapshotListSchema = cursorPageSchema(payrollSnapshotItemSchema);

const payrollAdjustmentListItemSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  adjustmentType: z.string(),
  section: z.string(),
  amountCents: z.number().nullable(),
  days: z.string().nullable(),
  reason: z.string(),
  status: z.string(),
  createdAt: wireDate(),
  userName: z.string().nullable(),
  userFirstName: z.string().nullable(),
  userLastName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

export const payrollAdjustmentListSchema = cursorPageSchema(payrollAdjustmentListItemSchema);

export const payrollAdjustmentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  periodId: z.number().int().nullable(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  adjustmentType: z.string(),
  section: z.string(),
  amountCents: z.number().nullable(),
  days: z.string().nullable(),
  reason: z.string(),
  sourceChangeRef: z.unknown().nullable(),
  status: z.string(),
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  rejectedBy: z.string().nullable(),
  rejectedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});
