import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const workflowTransitionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  fromStatusId: z.number().int().nullable(),
  toStatusId: z.number().int(),
  name: z.string().nullable(),
  requiresApproval: z.boolean(),
  requiredFields: z.array(z.string()),
  allowedRoles: z.array(z.string()),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: wireDate().nullable(),
});

export const projectStatusSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  name: z.string(),
  order: z.number().int(),
  color: z.string().nullable(),
  type: z.string(),
  wipLimit: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});
