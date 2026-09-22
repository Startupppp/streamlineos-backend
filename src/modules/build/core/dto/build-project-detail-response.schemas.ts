import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

const userColsSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});

const projectStatusSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  order: z.number().int(),
  color: z.string().nullable(),
  wipLimit: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const projectMemberDetailSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  membershipId: z.number().int(),
  role: z.string(),
  user: z.object({
    id: z.number().int(),
    user: userColsSchema,
  }),
});

export const projectRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  key: z.string(),
  clientMembershipId: z.number().int().nullable(),
  managerMembershipId: z.number().int().nullable(),
  startDate: nullableWireDate(),
  endDate: nullableWireDate(),
  status: z.string(),
  priority: z.string().nullable(),
  dealId: z.number().int().nullable(),
  managedProductId: z.number().int().nullable(),
  pmWorkspaceId: z.string().nullable(),
  budget: z.string().nullable(),
  budgetMinor: z.number().int().nullable(),
  budgetCurrency: z.string().nullable(),
  settings: z.unknown(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const projectDetailSchema = projectRowSchema.extend({
  statuses: z.array(projectStatusSchema),
  members: z.array(projectMemberDetailSchema),
});

