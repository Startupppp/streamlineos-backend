import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const managedProductRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  key: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  ownerId: z.string().nullable(),
  pmWorkspaceId: z.string().nullable(),
  vision: z.string().nullable(),
  missionStatement: z.string().nullable(),
  targetCustomer: z.string().nullable(),
  differentiators: z.string().nullable(),
  currentPhase: z.string().nullable(),
  targetLaunchDate: nullableWireDate(),
  successMetrics: z.unknown(),
  ownerMembershipId: z.number().int().nullable(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const managedProductPageSchema = cursorPageSchema(managedProductRowSchema);

export const managedProductInsightsSchema = z.object({
  linkedProjectCount: z.number().int(),
  projectsByStatus: z.object({
    active: z.number().int(),
    completed: z.number().int(),
    archived: z.number().int(),
  }),
  submissionsByStatus: z.object({
    open: z.number().int(),
    in_progress: z.number().int(),
    resolved: z.number().int(),
    archived: z.number().int(),
  }),
});
