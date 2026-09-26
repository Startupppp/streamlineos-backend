import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const portalProjectItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  key: z.string(),
  status: z.string(),
  startDate: nullableWireDate(),
  targetEndDate: nullableWireDate(),
});

export const portalMilestoneSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  dueDate: z.string().nullable(),
  status: z.string(),
});

export const portalTaskSchema = z.object({
  id: z.number().int(),
  ticketNumber: z.number().int(),
  title: z.string(),
  status: z.string(),
  dueDate: z.string().nullable(),
});

export const portalAttachmentSchema = z.object({
  id: z.number().int(),
  filename: z.string(),
  url: z.string(),
});

export const portalCommentSchema = z.object({
  id: z.number().int(),
  body: z.string(),
  authorName: z.string(),
  createdAt: wireDate(),
});

export const portalProjectOverviewSchema = z.object({
  project: portalProjectItemSchema,
  milestones: z.array(portalMilestoneSchema),
  tasks: z.array(portalTaskSchema),
  attachments: z.array(portalAttachmentSchema),
  comments: z.array(portalCommentSchema),
});

export const portalChangeRequestItemSchema = z.object({
  id: z.number().int(),
  crNumber: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  impact: z.string().nullable(),
  status: z.string(),
  estimateMinutes: z.number().int().nullable(),
  budgetImpactCents: z.number().int().nullable(),
  timelineImpactDays: z.number().int().nullable(),
  decisionComment: z.string().nullable(),
  createdAt: wireDate(),
});

const ticketVisibilityItemSchema = z.object({
  id: z.number().int(),
  ticketNumber: z.number().int(),
  title: z.string(),
  type: z.string(),
  clientVisible: z.boolean(),
});

const milestoneVisibilityItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  clientVisible: z.boolean(),
});

export const visibilitySummarySchema = z.object({
  tickets: cursorPageSchema(ticketVisibilityItemSchema),
  milestones: cursorPageSchema(milestoneVisibilityItemSchema),
});

export const toggleVisibilitySchema = z.object({
  id: z.number().int(),
  clientVisible: z.boolean(),
});
