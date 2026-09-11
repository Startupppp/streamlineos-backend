import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { successSchema, cursorPageSchema } from "../../../../common/openapi/response-envelopes";

const goalSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  targetValue: z.string().nullable(),
  currentValue: z.string(),
  unit: z.string().nullable(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.string(),
  progress: z.number().int(),
  parentGoalId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const keyResultSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  goalId: z.number().int(),
  title: z.string(),
  targetValue: z.string().nullable(),
  currentValue: z.string(),
  unit: z.string().nullable(),
  progress: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const pipSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  managerId: z.string(),
  managerMembershipId: z.number().int().nullable(),
  hrRepId: z.string().nullable(),
  hrRepMembershipId: z.number().int().nullable(),
  reason: z.string(),
  objectives: z
    .array(z.object({ objective: z.string(), metric: z.string(), deadline: z.string() }))
    .nullable(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.string(),
  outcome: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const reviewCycleSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  type: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  deadline: z.string().nullable(),
  status: z.string(),
  description: z.string().nullable(),
  templateId: z.number().int().nullable(),
  templateVersion: z.number().int().nullable(),
  ratingScale: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.string().nullable(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const reviewRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  reviewerId: z.string().nullable(),
  cycleId: z.number().int().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  ratings: z
    .array(z.object({ category: z.string(), score: z.number(), comment: z.string().optional() }))
    .nullable(),
  strengths: z.string().nullable(),
  improvements: z.string().nullable(),
  goals: z
    .array(z.object({ goal: z.string(), achieved: z.boolean() }))
    .nullable(),
  overallRating: z.string().nullable(),
  comments: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const userMinSchema = z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() });
const userNameSchema = z.object({ id: z.string(), name: z.string().nullable() });
const cycleMinSchema = z.object({ id: z.number().int(), name: z.string(), status: z.string() });

export const listGoalsResponseSchema = z.array(goalSchema);

export const createGoalResponseSchema = goalSchema;

export const updateGoalResponseSchema = successSchema;

export const myGoalsResponseSchema = z.object({
  goals: z.array(goalSchema),
  keyResults: z.array(keyResultSchema),
});

export const listKeyResultsResponseSchema = z.array(keyResultSchema);

export const createKeyResultResponseSchema = keyResultSchema;

export const updateKeyResultResponseSchema = successSchema;

const oneOnOneMeetingBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  managerId: z.string(),
  managerMembershipId: z.number().int().nullable(),
  employeeId: z.string(),
  employeeMembershipId: z.number().int().nullable(),
  duration: z.number().int(),
  status: z.string(),
  notes: z.string().nullable(),
  actionItems: z.array(z.object({ text: z.string(), done: z.boolean() })).nullable(),
  agenda: z.string().nullable(),
  meetingLink: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createOneOnOneResponseSchema = oneOnOneMeetingBaseSchema.extend({
  scheduledAt: wireDate(),
});

export const listOneOnOnesResponseSchema = z.array(
  oneOnOneMeetingBaseSchema.extend({
    scheduledAt: z.string(),
    manager: userMinSchema.nullable(),
    employee: userMinSchema.nullable(),
  }),
);

export const updateOneOnOneResponseSchema = successSchema;

export const listPipsResponseSchema = z.array(
  pipSchema.extend({
    user: userMinSchema.nullable(),
    manager: userNameSchema.nullable(),
    hrRep: userNameSchema.nullable(),
  }),
);

export const createPipResponseSchema = pipSchema;

export const updatePipResponseSchema = successSchema;

const reviewListRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  reviewerId: z.string().nullable(),
  cycleId: z.number().int().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: z.string(),
  overallRating: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: userMinSchema.nullable(),
  reviewer: userNameSchema.nullable(),
  cycle: cycleMinSchema.nullable(),
});

export const listReviewsResponseSchema = cursorPageSchema(reviewListRowSchema);

export const createReviewResponseSchema = reviewRowSchema;

export const getReviewResponseSchema = reviewRowSchema.extend({
  user: userMinSchema.nullable(),
  reviewer: userNameSchema.nullable(),
  cycle: reviewCycleSchema.nullable(),
});

export const updateReviewResponseSchema = successSchema;

export const listCyclesResponseSchema = z.array(reviewCycleSchema);

export const createCycleResponseSchema = reviewCycleSchema;

const reviewSummarySchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  reviewerId: z.string().nullable(),
  status: z.string(),
  overallRating: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  createdAt: wireDate(),
  user: userMinSchema.nullable(),
  reviewer: userNameSchema.nullable(),
});

export const getCycleResponseSchema = reviewCycleSchema.extend({
  reviews: z.array(reviewSummarySchema),
});

export const updateCycleResponseSchema = successSchema;
