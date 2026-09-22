import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { changeRequestStatusEnum } from "../../../../db/schema";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const changeRequestListPageSchema = cursorPageSchema(
  z.object({
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
    status: z.enum(changeRequestStatusEnum.enumValues),
    requestedById: z.string().nullable(),
    approvalOwnerId: z.string().nullable(),
    approvalOwnerMembershipId: z.number().int().nullable(),
    decisionComment: z.string().nullable(),
    decidedAt: nullableWireDate(),
    createdBy: z.string().nullable(),
    createdAt: z.union([wireDate(), z.string()]),
    updatedAt: wireDate(),
    deletedAt: nullableWireDate(),
  }),
);

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
  status: z.enum(changeRequestStatusEnum.enumValues),
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
