import { z } from "zod";

import {
  projectPrioritySchema,
  refineDueDateRange,
  refineDueOnOrAfterStart,
} from "./project-core.schemas";
import {
  baseListQuerySchema,
  pageSizeField,
} from "../../../../common/pagination/list-query.schema";
import { ticketTypeEnum, ticketPriorityEnum, portfolioHealthEnum } from "../../../../db/schema";

const SEARCH_TERM_MAX_LENGTH = 200;

function normalizeCsv(value: unknown) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return value;
  return value.split(",").map((item) => item.trim());
}

const csvToStringArray = z.preprocess(
  normalizeCsv,
  z.array(z.string().min(1)).max(100).optional(),
);

const csvToIntArray = z.preprocess(
  normalizeCsv,
  z
    .array(
      z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int().positive().max(2_147_483_647)),
    )
    .max(100)
    .optional(),
);

const csvToTicketPriorityArray = z.preprocess(
  normalizeCsv,
  z
    .array(z.enum(ticketPriorityEnum.enumValues))
    .max(100)
    .optional(),
);

const csvToTicketTypeArray = z.preprocess(
  normalizeCsv,
  z
    .array(z.enum(ticketTypeEnum.enumValues))
    .max(100)
    .optional(),
);

const csvToHealthArray = z.preprocess(
  normalizeCsv,
  z
    .array(z.enum(portfolioHealthEnum.enumValues))
    .max(100)
    .optional(),
);

export const ticketsListQuerySchema = baseListQuerySchema
  .omit({ page: true, sortDir: true })
  .extend({
    search: z.string().trim().max(SEARCH_TERM_MAX_LENGTH).optional(),
    status: csvToStringArray,
    priority: csvToTicketPriorityArray,
    type: csvToTicketTypeArray,
    assigneeId: csvToStringArray,
    labelIds: csvToIntArray,
    cycleId: csvToIntArray,
    moduleIds: csvToIntArray,
    epicId: z.coerce.number().int().positive().optional(),
    health: csvToHealthArray,
    dueDateFrom: z.iso.date().optional(),
    dueDateTo: z.iso.date().optional(),
    orderBy: z
      .enum(["created", "updated", "priority", "dueDate", "rank"])
      .default("rank"),
    orderDir: z.enum(["asc", "desc"]).optional(),
  })
  .strict()
  .superRefine((data, ctx) => refineDueDateRange(data, ctx));

export const allWorkQuerySchema = baseListQuerySchema
  .omit({ page: true, sortDir: true })
  .extend({
    search: z.string().trim().max(SEARCH_TERM_MAX_LENGTH).optional(),
    status: csvToStringArray,
    priority: csvToTicketPriorityArray,
    type: csvToTicketTypeArray,
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
    managedProductId: z.coerce.number().int().positive().optional(),
    teamId: z.coerce.number().int().positive().optional(),
    excludeStatus: csvToStringArray,
      scope: z.enum(["all", "mine", "created", "subscribed", "mentioned", "blocked", "recently-completed"]).default("all"),
  })
  .strict()
  .superRefine((data, ctx) => refineDueDateRange(data, ctx));

export const searchTicketsQuerySchema = z.object({
  q: z.string().trim().max(SEARCH_TERM_MAX_LENGTH).default(""),
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
  type: z.enum(ticketTypeEnum.enumValues).default("TASK"),
  priority: z.enum(ticketPriorityEnum.enumValues).optional(),
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
    type: z.enum(ticketTypeEnum.enumValues).optional(),
    status: z.string().optional(),
    priority: z.enum(ticketPriorityEnum.enumValues).optional(),
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
    version: z.number().int().positive(),
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
    labelIds: z.array(z.number().int().positive()).max(10).optional(),
    archive: z.boolean().optional(),
  }).strict()
  .refine(
    (data) =>
      data.assigneeId !== undefined ||
      data.status !== undefined ||
      data.cycleId !== undefined ||
      data.priority !== undefined ||
      data.parentTicketId !== undefined ||
      data.labelIds !== undefined ||
      data.archive !== undefined,
    { message: "At least one field to update is required" },
  );

const csvToNumberArray = z.preprocess(
  normalizeCsv,
  z
    .array(
      z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int().positive().max(2_147_483_647)),
    )
    .max(100)
    .optional(),
);

export const exportTicketsQuerySchema = z.object({
  ticketIds: csvToNumberArray,
}).strict();

export const rankTicketSchema = z.object({
  beforeTicketId: z.number().int().positive().nullable().optional(),
  afterTicketId: z.number().int().positive().nullable().optional(),
  status: z.string().optional(),
}).strict();

export const importTicketRowSchema = z.object({
  title: z.string().min(1).max(500),
  type: z.enum(ticketTypeEnum.enumValues).optional(),
  status: z.string().optional(),
  priority: z.enum(ticketPriorityEnum.enumValues).optional(),
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
export type ExportTicketsQuery = z.infer<typeof exportTicketsQuerySchema>;
export type RankTicketInput = z.infer<typeof rankTicketSchema>;
