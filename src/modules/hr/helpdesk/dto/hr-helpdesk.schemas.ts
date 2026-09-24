import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { HELPDESK_CATEGORIES, SUPPORT_QUEUES } from "../lib/support-queues";

const ticketStatusSchema = z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
const ticketPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const categorySchema = z.enum(HELPDESK_CATEGORIES);
export const supportQueueSchema = z.enum(SUPPORT_QUEUES);

export const listSchema = z.object({
  userId: z.string().min(1).optional(),
  status: ticketStatusSchema.optional(),
  category: categorySchema.optional(),
  queue: supportQueueSchema.optional(),
  assigneeId: z.string().min(1).optional(),
  q: z.string().min(1).max(200).optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export const myRequestsListSchema = z.object({
  status: ticketStatusSchema.optional(),
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
}).strict();

export const createSchema = z.object({
  title: z
    .string()
    .min(5, "Ticket title must be at least 5 characters")
    .max(150, "Ticket title must be at most 150 characters")
    .refine((v) => /[a-zA-Z0-9]/.test(v.trim()), "Ticket title must contain at least one letter or digit"),
  description: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(10).max(2000).optional(),
  ),
  category: categorySchema,
  priority: ticketPrioritySchema.optional(),
  isConfidential: z.boolean().optional(),
}).strict();

export const updateTicketSchema = z.object({
  status: ticketStatusSchema.optional(),
  assigneeId: z.string().nullable().optional(),
  priority: ticketPrioritySchema.optional(),
  queue: supportQueueSchema.optional(),
  resolution: z.string().max(2000).nullable().optional(),
}).strict();

export const addCommentSchema = z.object({
  body: z.string().min(1).max(2000),
}).strict();

export const routingRuleSchema = z
  .object({
    category: categorySchema,
    queue: supportQueueSchema.optional(),
    assigneeUserId: z.string().min(1).optional(),
  })
  .strict()
  .refine((rule) => rule.queue !== undefined || rule.assigneeUserId !== undefined, {
    message: "A routing rule names a queue, an assignee, or both",
  });

export const queueConfigSchema = z.object({
  firstResponseHours: z.number().int().min(1).max(24 * 30),
  resolutionHours: z.number().int().min(1).max(24 * 90),
  escalationUserId: z.string().min(1).nullable(),
}).strict().refine((config) => config.firstResponseHours <= config.resolutionHours, {
  message: "First response must be due no later than resolution",
});

export const queueParams = z.object({ queue: supportQueueSchema }).strict();

export const suggestSchema = z.object({
  query: z.string().min(2).max(200),
}).strict();

export type ListInput = z.infer<typeof listSchema>;
export type MyRequestsListInput = z.infer<typeof myRequestsListSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type AddCommentInput = z.infer<typeof addCommentSchema>;
export type RoutingRuleInput = z.infer<typeof routingRuleSchema>;
export type QueueConfigInput = z.infer<typeof queueConfigSchema>;
export type SuggestInput = z.infer<typeof suggestSchema>;
