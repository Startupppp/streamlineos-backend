import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const changeRequestRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  crNumber: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  impact: z.string().nullable(),
  estimateMinutes: z.number().int().nullable(),
  budgetImpactCents: z.number().int().nullable(),
  timelineImpactDays: z.number().int().nullable(),
  status: z.string(),
  requestedById: z.string().nullable(),
  approvalOwnerId: z.string().nullable(),
  approvalOwnerMembershipId: z.number().int().nullable(),
  decisionComment: z.string().nullable(),
  decidedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});
