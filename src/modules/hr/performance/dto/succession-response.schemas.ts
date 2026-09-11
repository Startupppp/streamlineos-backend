import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const successionPlanSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  positionId: z.string().nullable(),
  positionTitle: z.string().nullable(),
  incumbentUserId: z.string().nullable(),
  incumbentMembershipId: z.number().int().nullable(),
  successorUserId: z.string().nullable(),
  successorMembershipId: z.number().int().nullable(),
  readiness: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const listSuccessionPlansResponseSchema = z.object({
  items: z.array(successionPlanSchema),
  nextCursor: z.string().nullable(),
});

export const createSuccessionPlanResponseSchema = successionPlanSchema;

export const updateSuccessionPlanResponseSchema = successionPlanSchema;
