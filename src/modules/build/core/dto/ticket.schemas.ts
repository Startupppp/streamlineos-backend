import { z } from "zod";

import {
  projectPrioritySchema,
  refineDueOnOrAfterStart,
} from "./project-core.schemas";

const csvToStringArray = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

const csvToIntArray = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n))
      : undefined,
  );

export const ticketsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().optional(),
  status: csvToStringArray,
  priority: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is "LOW" | "MEDIUM" | "HIGH" | "URGENT" =>
              ["LOW", "MEDIUM", "HIGH", "URGENT"].includes(s),
            )
        : undefined,
    ),
  type: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is "TASK" | "BUG" | "STORY" | "EPIC" | "SUBTASK" =>
              ["TASK", "BUG", "STORY", "EPIC", "SUBTASK"].includes(s),
            )
        : undefined,
    ),
  assigneeId: csvToStringArray,
  labelIds: csvToIntArray,
  sprintId: z.coerce.number().int().positive().optional(),
  cycleId: csvToIntArray,
  epicId: z.coerce.number().int().positive().optional(),
  dueDateFrom: z.string().optional(),
  dueDateTo: z.string().optional(),
  orderBy: z
    .enum(["created", "updated", "priority", "dueDate", "rank"])
    .default("rank"),
  orderDir: z.enum(["asc", "desc"]).optional(),
});

export const allWorkQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().optional(),
  status: csvToStringArray,
  priority: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is "LOW" | "MEDIUM" | "HIGH" | "URGENT" =>
              ["LOW", "MEDIUM", "HIGH", "URGENT"].includes(s),
            )
        : undefined,
    ),
  type: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is "TASK" | "BUG" | "STORY" | "EPIC" | "SUBTASK" =>
              ["TASK", "BUG", "STORY", "EPIC", "SUBTASK"].includes(s),
            )
        : undefined,
    ),
  assigneeId: csvToStringArray,
  labelIds: csvToIntArray,
  sprintId: z.coerce.number().int().positive().optional(),
  cycleId: csvToIntArray,
  epicId: z.coerce.number().int().positive().optional(),
  dueDateFrom: z.string().optional(),
  dueDateTo: z.string().optional(),
  orderBy: z
    .enum(["created", "updated", "priority", "dueDate", "rank"])
    .default("rank"),
  orderDir: z.enum(["asc", "desc"]).optional(),
  projectIds: csvToIntArray,
  excludeStatus: csvToStringArray,
  scope: z.enum(["all", "mine", "created", "subscribed"]).default("all"),
  pmWorkspaceId: z.string().optional(),
});

export const searchTicketsQuerySchema = z.object({
  q: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type SearchTicketsQuery = z.infer<typeof searchTicketsQuerySchema>;

export const ticketActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
export type TicketActivityQuery = z.infer<typeof ticketActivityQuerySchema>;

export const recurrenceRuleSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(99),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  endDate: z.string().nullable().optional(),
});

export type RecurrenceRuleInput = z.infer<typeof recurrenceRuleSchema>;

export const createTicketSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, "Title must be at least 3 characters")
    .max(500)
    .refine((v) => /[a-zA-Z0-9]/.test(v), {
      message: "Title must contain at least one letter or number",
    }),
  description: z.string().optional(),
  type: z.enum(["TASK", "BUG", "STORY", "EPIC", "SUBTASK"]).default("TASK"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeId: z.string().optional(),
  assigneeIds: z.array(z.string()).optional(),
  reporterId: z.string().optional(),
  sprintId: z.number().optional(),
  epicId: z.number().optional(),
  cycleId: z.number().optional(),
  points: z.number().optional(),
  link: z.string().optional(),
  originalEstimate: z.number().optional(),
  parentTicketId: z.number().optional(),
  status: z.string().optional(),
  isRecurring: z.boolean().optional(),
  recurrenceRule: recurrenceRuleSchema.nullable().optional(),
});

export const updateTicketSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(3, "Title must be at least 3 characters")
      .max(500)
      .refine((v) => /[a-zA-Z0-9]/.test(v), {
        message: "Title must contain at least one letter or number",
      })
      .optional(),
    description: z.string().nullable().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    assigneeId: z.string().optional(),
    assigneeIds: z.array(z.string()).optional(),
    sprintId: z.number().nullable().optional(),
    epicId: z.number().nullable().optional(),
    moduleId: z.number().nullable().optional(),
    points: z.number().nullable().optional(),
    originalEstimate: z.number().nullable().optional(),
    startDate: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    cycleId: z.number().nullable().optional(),
    expectedUpdatedAt: z.string().optional(),
    version: z.number().int().positive().optional(),
    isRecurring: z.boolean().optional(),
    recurrenceRule: recurrenceRuleSchema.nullable().optional(),
    customerId: z.number().int().positive().nullable().optional(),
    parentTicketId: z.number().int().positive().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    refineDueOnOrAfterStart(data, ctx);
  });

export const bulkUpdateSchema = z
  .object({
    ticketIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(100, "Cannot update more than 100 tickets at once"),
    assigneeId: z.string().optional(),
    status: z.string().optional(),
    sprintId: z.number().int().positive().nullable().optional(),
    priority: projectPrioritySchema.optional(),
    parentTicketId: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (data) =>
      data.assigneeId !== undefined ||
      data.status !== undefined ||
      data.sprintId !== undefined ||
      data.priority !== undefined ||
      data.parentTicketId !== undefined,
    { message: "At least one field to update is required" },
  );

export const rankTicketSchema = z.object({
  beforeTicketId: z.number().int().positive().nullable().optional(),
  afterTicketId: z.number().int().positive().nullable().optional(),
  status: z.string().optional(),
});

export const commentSchema = z.object({
  content: z.string().min(1),
  parentCommentId: z.number().int().positive().optional(),
});

export const updateCommentSchema = z.object({ content: z.string().min(1) });
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

export const addRelationSchema = z.object({
  relatedTicketId: z.number().int().positive(),
  relationType: z.enum(["blocks", "blocked_by", "duplicate_of", "relates_to"]),
});

export const addWatcherSchema = z.object({
  userId: z.string().optional(),
});

export const addLabelSchema = z.object({ labelId: z.number() });

export const attachmentSchema = z.object({
  fileName: z.string().min(1),
  fileUrl: z.string().min(1),
  fileKey: z.string().optional(),
  fileSize: z.number(),
  mimeType: z.string(),
});

export const addRelatedLinkSchema = z.object({
  url: z.string().url("Must be a valid URL").max(2000),
  label: z.string().trim().max(200).optional(),
});

export const updateRelatedLinkSchema = z.object({
  url: z.string().url("Must be a valid URL").max(2000).optional(),
  label: z.string().trim().max(200).nullable().optional(),
});

export type AddRelatedLinkInput = z.infer<typeof addRelatedLinkSchema>;
export type UpdateRelatedLinkInput = z.infer<typeof updateRelatedLinkSchema>;

export const addReactionSchema = z.object({
  emoji: z.string().min(1).max(10),
});
export type AddReactionInput = z.infer<typeof addReactionSchema>;

export const removeRelationQuerySchema = z.object({
  relatedId: z.coerce.number().int().positive(),
});
export type RemoveRelationQuery = z.infer<typeof removeRelationQuerySchema>;

export const importTicketRowSchema = z.object({
  title: z.string().min(1).max(500),
  type: z.enum(["TASK", "BUG", "STORY", "EPIC"]).optional(),
  status: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  points: z.number().int().min(0).optional(),
  assigneeEmail: z.string().email().optional(),
  dueDate: z.string().optional(),
});

export const importTicketsSchema = z.object({
  rows: z.array(importTicketRowSchema).min(1).max(500),
});

export type ImportTicketsInput = z.infer<typeof importTicketsSchema>;

export type TicketsListQuery = z.infer<typeof ticketsListQuerySchema>;
export type AllWorkQuery = z.infer<typeof allWorkQuerySchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;
export type RankTicketInput = z.infer<typeof rankTicketSchema>;
export type CommentInput = z.infer<typeof commentSchema>;
export type AddRelationInput = z.infer<typeof addRelationSchema>;
export type AddWatcherInput = z.infer<typeof addWatcherSchema>;
export type AddLabelInput = z.infer<typeof addLabelSchema>;
export type AttachmentInput = z.infer<typeof attachmentSchema>;
