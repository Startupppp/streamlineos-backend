import { z } from "zod";

import {
  projectPrioritySchema,
  refineDueOnOrAfterStart,
} from "./project-core.schemas";
import {
  baseListQuerySchema,
  pageSizeField,
} from "../../../../common/pagination/list-query.schema";

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

export const ticketsListQuerySchema = baseListQuerySchema
  .omit({ page: true, sortDir: true })
  .extend({
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
    cycleId: csvToIntArray,
    moduleIds: csvToIntArray,
    epicId: z.coerce.number().int().positive().optional(),
    dueDateFrom: z.iso.date().optional(),
    dueDateTo: z.iso.date().optional(),
    orderBy: z
      .enum(["created", "updated", "priority", "dueDate", "rank"])
      .default("rank"),
    orderDir: z.enum(["asc", "desc"]).optional(),
  }).strict();

export const allWorkQuerySchema = baseListQuerySchema
  .omit({ page: true, sortDir: true })
  .extend({
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
    cycleId: csvToIntArray,
    epicId: z.coerce.number().int().positive().optional(),
    dueDateFrom: z.iso.date().optional(),
    dueDateTo: z.iso.date().optional(),
    orderBy: z
      .enum(["created", "updated", "priority", "dueDate", "rank"])
      .default("rank"),
    orderDir: z.enum(["asc", "desc"]).optional(),
    projectIds: csvToIntArray,
    excludeStatus: csvToStringArray,
    scope: z.enum(["all", "mine", "created", "subscribed"]).default("all"),
  }).strict();

export const searchTicketsQuerySchema = z.object({
  q: z.string().default(""),
  limit: pageSizeField(10, 20),
}).strict();
export type SearchTicketsQuery = z.infer<typeof searchTicketsQuerySchema>;

export const ticketActivityQuerySchema = baseListQuerySchema.omit({ page: true, sortDir: true }).strict();
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
  assigneeIds: z.array(z.string()).max(20).optional(),
  reporterId: z.string().optional(),
  epicId: z.number().optional(),
  cycleId: z.number().optional(),
  points: z.number().int("Story points must be an integer").min(0, "Story points cannot be negative").optional(),
  link: z.string().optional(),
  originalEstimate: z.number().min(0, "Original estimate cannot be negative").optional(),
  parentTicketId: z.number().optional(),
  status: z.string().optional(),
  isRecurring: z.boolean().optional(),
  recurrenceRule: recurrenceRuleSchema.nullable().optional(),
}).strict();

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
    assigneeIds: z.array(z.string()).max(20).optional(),
    epicId: z.number().nullable().optional(),
    moduleId: z.number().nullable().optional(),
    points: z.number().int("Story points must be an integer").min(0, "Story points cannot be negative").nullable().optional(),
    originalEstimate: z.number().min(0, "Original estimate cannot be negative").nullable().optional(),
    startDate: z.iso.date().nullable().optional(),
    dueDate: z.iso.date().nullable().optional(),
    cycleId: z.number().nullable().optional(),
    expectedUpdatedAt: z.string().optional(),
    version: z.number().int().positive().optional(),
    isRecurring: z.boolean().optional(),
    recurrenceRule: recurrenceRuleSchema.nullable().optional(),
    customerId: z.number().int().positive().nullable().optional(),
    parentTicketId: z.number().int().positive().nullable().optional(),
  }).strict()
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
    cycleId: z.number().int().positive().nullable().optional(),
    priority: projectPrioritySchema.optional(),
    parentTicketId: z.number().int().positive().nullable().optional(),
  }).strict()
  .refine(
    (data) =>
      data.assigneeId !== undefined ||
      data.status !== undefined ||
      data.cycleId !== undefined ||
      data.priority !== undefined ||
      data.parentTicketId !== undefined,
    { message: "At least one field to update is required" },
  );

export const rankTicketSchema = z.object({
  beforeTicketId: z.number().int().positive().nullable().optional(),
  afterTicketId: z.number().int().positive().nullable().optional(),
  status: z.string().optional(),
}).strict();

export const importTicketRowSchema = z.object({
  title: z.string().min(1).max(500),
  type: z.enum(["TASK", "BUG", "STORY", "EPIC"]).optional(),
  status: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  points: z.number().int().min(0).optional(),
  assigneeEmail: z.string().email().optional(),
  dueDate: z.iso.date().optional(),
});

export const importTicketsSchema = z.object({
  rows: z.array(importTicketRowSchema).min(1).max(500),
}).strict();

export type ImportTicketsInput = z.infer<typeof importTicketsSchema>;

export type TicketsListQuery = z.infer<typeof ticketsListQuerySchema>;
export type AllWorkQuery = z.infer<typeof allWorkQuerySchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;
export type RankTicketInput = z.infer<typeof rankTicketSchema>;
