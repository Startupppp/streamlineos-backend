import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { ticketPriorityEnum, ticketTypeEnum } from "../../../../db/schema/common/enums";

export const commentDraftSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  membershipId: z.number().int().nullable(),
  ticketId: z.number().int(),
  body: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const assigneeSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  lastName: z.string().nullable(),
  firstName: z.string().nullable(),
});

const ticketSummarySchema = z.object({
  id: z.number().int(),
  type: z.enum(ticketTypeEnum.enumValues),
  title: z.string(),
  projectId: z.number().int().nullable(),
  status: z.string(),
  ticketNumber: z.number().int(),
  projectKey: z.string().nullable(),
  priority: z.enum(ticketPriorityEnum.enumValues).nullable(),
  projectName: z.string().nullable(),
  assignee: assigneeSchema.nullable(),
});

export const commentDraftWithTicketSchema = commentDraftSchema.extend({
  ticket: ticketSummarySchema,
});

export const deletedSchema = z.object({ deleted: z.boolean() });

export const draftFailureSchema = z.object({
  retryCount: z.number().int().nonnegative(),
  retriesRemaining: z.number().int().nonnegative(),
});

const aiUsageSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  credits: z.number(),
  costUsd: z.number(),
});

export const generatedCommentDraftSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  membershipId: z.number().int().nullable(),
  ticketId: z.number().int(),
  body: z.string(),
  evidence: z.string().nullable(),
  proposedChange: z.string().nullable(),
  impact: z.string().nullable(),
  confidence: z.number().int().nullable(),
  affectedRecordIds: z.string().nullable(),
  retryCount: z.number().int().nullable(),
  lastError: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  aiUsage: aiUsageSchema,
});
