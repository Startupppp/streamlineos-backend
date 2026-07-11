import { z } from "zod";

export const HELPDESK_CATEGORIES = [
  "policy_question",
  "payroll_issue",
  "document_request",
  "leave_issue",
  "benefits",
  "it_access",
  "confidential",
  "other",
] as const;

export type HelpdeskCategory = (typeof HELPDESK_CATEGORIES)[number];

const ticketStatusSchema = z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
const ticketPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);
const categorySchema = z.enum(HELPDESK_CATEGORIES);

export const listSchema = z.object({
  userId: z.string().min(1).optional(),
  status: ticketStatusSchema.optional(),
  category: categorySchema.optional(),
  assigneeId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

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
});

export const updateTicketSchema = z.object({
  status: ticketStatusSchema.optional(),
  assigneeId: z.string().nullable().optional(),
  priority: ticketPrioritySchema.optional(),
  resolution: z.string().max(2000).nullable().optional(),
});

export const addCommentSchema = z.object({
  body: z.string().min(1).max(2000),
});

export const routingRuleSchema = z.object({
  category: categorySchema,
  assigneeUserId: z.string().min(1),
});

export const suggestSchema = z.object({
  query: z.string().min(2).max(200),
});

export type ListInput = z.infer<typeof listSchema>;
export type CreateInput = z.infer<typeof createSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type AddCommentInput = z.infer<typeof addCommentSchema>;
export type RoutingRuleInput = z.infer<typeof routingRuleSchema>;
export type SuggestInput = z.infer<typeof suggestSchema>;
