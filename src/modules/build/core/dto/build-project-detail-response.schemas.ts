import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { DB_ENUMS } from "../../../../db/enums.generated";

const userColsSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});

export const projectStatusSchema = z.object({
  id: z.number().int(),
  projectId: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  order: z.number().int(),
  color: z.string().nullable(),
  type: z.enum(DB_ENUMS.state_group).nullable(),
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
  status: z.enum(DB_ENUMS.project_status),
  priority: z.string().nullable(),
  dealId: z.number().int().nullable(),
  managedProductId: z.number().int().nullable(),
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
  crmClient: z.object({ id: z.number().int(), name: z.string() }).nullable(),
});

