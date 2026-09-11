import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const goalOwnerSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
});

const goalProjectSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  key: z.string(),
});

export const goalRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  level: z.string(),
  status: z.string(),
  progress: z.number().int(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  parentGoalId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const goalListItemSchema = goalRowSchema.extend({
  owner: goalOwnerSchema.nullable(),
  keyResultCount: z.number().int(),
});

export const goalsListResponseSchema = z.object({
  items: z.array(goalListItemSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const goalStatsSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  avgProgress: z.number(),
  atRisk: z.number().int(),
  completed: z.number().int(),
});

const keyResultRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  goalId: z.number().int(),
  title: z.string(),
  metricType: z.string(),
  startValue: z.string(),
  targetValue: z.string(),
  currentValue: z.string(),
  unit: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const goalUpdateRowSchema = z.object({
  id: z.number().int(),
  keyResultId: z.number().int().nullable(),
  note: z.string().nullable(),
  previousValue: z.string().nullable(),
  newValue: z.string().nullable(),
  createdAt: wireDate(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
  userImage: z.string().nullable(),
});

const goalLinkRowSchema = z.object({
  id: z.number().int(),
  ticketId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  createdAt: wireDate(),
  ticketTitle: z.string().nullable(),
  ticketProjectId: z.number().int().nullable(),
  projectName: z.string().nullable(),
  projectKey: z.string().nullable(),
});

export const goalDetailSchema = goalRowSchema.extend({
  owner: goalOwnerSchema.nullable(),
  project: goalProjectSchema.nullable(),
  keyResults: z.array(keyResultRowSchema),
  updates: z.array(goalUpdateRowSchema),
  links: z.array(goalLinkRowSchema),
});

export const goalLinksListSchema = z.array(goalLinkRowSchema);

export const goalLinkCreatedSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  goalId: z.number().int(),
  ticketId: z.number().int().nullable(),
  projectId: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const goalSuccessSchema = z.object({ success: z.literal(true) });
