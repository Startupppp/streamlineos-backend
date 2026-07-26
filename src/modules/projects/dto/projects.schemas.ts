import { z } from "zod";

export const listProjectsSchema = z.object({
  search: z.string().optional(),
  status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED", "ALL"]).default("ALL"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(9),
});

const projectModulesSchema = z.object({
  sprints: z.boolean(),
  epics: z.boolean(),
  timeTracking: z.boolean(),
  wiki: z.boolean(),
});

const projectPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

function refineEndAfterStart(
  data: { startDate?: string | null; endDate?: string | null },
  ctx: z.RefinementCtx,
  message = "End date must be after start date",
): void {
  const start = data.startDate;
  const end = data.endDate;
  if (!start || !end) return;
  if (end <= start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
      path: ["endDate"],
    });
  }
}

function refineDueOnOrAfterStart(
  data: { startDate?: string | null; dueDate?: string | null },
  ctx: z.RefinementCtx,
): void {
  const start = data.startDate;
  const due = data.dueDate;
  if (!start || !due) return;
  if (due < start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Due date must be on or after start date",
      path: ["dueDate"],
    });
  }
}

export const createProjectSchema = z
  .object({
    name: z
      .string()
      .min(2, "Project name must be at least 2 characters")
      .max(100, "Project name must be 100 characters or fewer")
      .trim()
      .refine((v) => v.trim().length > 0, {
        message: "Project name cannot be blank",
      }),
    description: z
      .string()
      .max(2000, "Description must be 2000 characters or fewer")
      .optional(),
    key: z
      .string()
      .min(2, "Project key must be at least 2 characters")
      .max(10, "Project key must be 10 characters or fewer")
      .regex(
        /^[A-Z][A-Z0-9]*$/,
        "Key must start with a letter and contain only uppercase letters/numbers",
      )
      .optional(),
    managerId: z.string().optional(),
    clientId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    memberIds: z.array(z.string()).optional(),
    modules: projectModulesSchema.optional(),
    projectType: z.string().optional(),
    workflow: z.string().optional(),
    features: z.record(z.string(), z.boolean()).optional(),
    priority: projectPrioritySchema.optional(),
  })
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const updateProjectSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
    managerId: z.string().nullable().optional(),
    clientId: z.string().optional(),
    startDate: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
    memberIds: z.array(z.string()).optional(),
    reassignments: z.record(z.string(), z.string()).optional(),
    projectType: z.string().optional(),
    workflow: z.string().optional(),
    features: z.record(z.string(), z.boolean()).optional(),
    priority: projectPrioritySchema.optional(),
  })
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const updateBudgetSchema = z.object({
  budget: z.number().min(0),
});

export const fromDealSchema = z
  .object({
    dealId: z.number().int().positive(),
    name: z.string().min(1),
    description: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.string().default("CONTRIBUTOR"),
});

export const removeMemberSchema = z.object({
  userId: z.string().min(1),
});

export const updateProjectMemberRoleSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});

export type UpdateProjectMemberRoleInput = z.infer<
  typeof updateProjectMemberRoleSchema
>;

const columnNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(50, "Name must be 50 characters or fewer")
  .refine((v) => /[a-zA-Z0-9]/.test(v), {
    message: "Name must contain at least one letter or number",
  });

export const projectStatusTypeSchema = z.enum([
  "unstarted",
  "started",
  "completed",
  "cancelled",
]);

export const createStateSchema = z.object({
  name: columnNameSchema,
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  order: z.number().int().min(0).optional(),
  type: projectStatusTypeSchema.optional(),
});

export const updateCustomStateSchema = z.object({
  name: columnNameSchema.optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  order: z.number().int().min(0).optional(),
  type: projectStatusTypeSchema.optional(),
});

export const createLabelSchema = z.object({
  name: z.string().min(1, "Label name is required"),
  color: z.string().optional(),
});

export const updateLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
});

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
    .enum(["created", "updated", "priority", "dueDate", "order"])
    .default("order"),
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
    .enum(["created", "updated", "priority", "dueDate", "order"])
    .default("order"),
  orderDir: z.enum(["asc", "desc"]).optional(),
  projectIds: csvToIntArray,
  excludeStatus: csvToStringArray,
  scope: z.enum(["all", "mine", "created", "subscribed"]).default("all"),
});

export const searchTicketsQuerySchema = z.object({
  q: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type SearchTicketsQuery = z.infer<typeof searchTicketsQuerySchema>;

export const ticketActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
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
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
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

export const reorderSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      status: z.string(),
      order: z.number(),
    }),
  ),
});

export const commentSchema = z.object({
  content: z.string().min(1),
  parentCommentId: z.number().int().positive().optional(),
});

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

const templateTicketSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.string().default("TASK"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  estimatedHours: z.number().positive().optional(),
  order: z.number().int().default(0),
  phase: z.string().optional(),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  category: z.string().default("GENERAL"),
  tickets: z.array(templateTicketSchema).default([]),
});

export const applyTemplateSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    managerId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    refineEndAfterStart(data, ctx);
  });

export const burnupQuerySchema = z.object({
  sprintId: z.string().regex(/^\d+$/).optional(),
});

export const cfdQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
});

export const roadmapListQuerySchema = z.object({
  status: z
    .enum(["planned", "in_progress", "completed", "cancelled"])
    .optional(),
  search: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createRoadmapSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  status: z
    .enum(["planned", "in_progress", "completed", "cancelled"])
    .default("planned"),
  category: z.string().trim().max(100).optional(),
  isPublic: z.boolean().default(true),
  projectId: z.number().int().positive().optional(),
  epicTicketId: z.number().int().positive().optional(),
  targetQuarter: z.string().trim().max(20).optional(),
  sortOrder: z.number().int().default(0),
});

export const updateRoadmapSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  status: z
    .enum(["planned", "in_progress", "completed", "cancelled"])
    .optional(),
  category: z.string().trim().max(100).nullable().optional(),
  isPublic: z.boolean().optional(),
  projectId: z.number().int().positive().nullable().optional(),
  epicTicketId: z.number().int().positive().nullable().optional(),
  targetQuarter: z.string().trim().max(20).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

export const feedbackListQuerySchema = z.object({
  status: z
    .enum(["open", "planned", "in_progress", "completed", "declined"])
    .optional(),
  search: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  status: z
    .enum(["open", "planned", "in_progress", "completed", "declined"])
    .default("open"),
  category: z.string().trim().max(100).optional(),
  submittedByName: z.string().trim().max(120).optional(),
  submittedByEmail: z.string().trim().email().optional(),
  linkedRoadmapItemId: z.number().int().positive().optional(),
});

export const updateFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  status: z
    .enum(["open", "planned", "in_progress", "completed", "declined"])
    .optional(),
  category: z.string().trim().max(100).nullable().optional(),
  linkedRoadmapItemId: z.number().int().positive().nullable().optional(),
});

export const changelogListQuerySchema = z.object({
  type: z.enum(["feature", "improvement", "fix"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createChangelogSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().max(20000).default(""),
  version: z.string().trim().max(40).optional(),
  type: z.enum(["feature", "improvement", "fix"]).default("feature"),
  isPublished: z.boolean().default(false),
  linkedRoadmapItemId: z.number().int().positive().optional(),
});

export const updateChangelogSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().max(20000).optional(),
  version: z.string().trim().max(40).nullable().optional(),
  type: z.enum(["feature", "improvement", "fix"]).optional(),
  isPublished: z.boolean().optional(),
  linkedRoadmapItemId: z.number().int().positive().nullable().optional(),
});

export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;
export type UpdateCustomStateInput = z.infer<typeof updateCustomStateSchema>;
export type ListProjectsInput = z.infer<typeof listProjectsSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;
export type FromDealInput = z.infer<typeof fromDealSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type RemoveMemberInput = z.infer<typeof removeMemberSchema>;
export type CreateStateInput = z.infer<typeof createStateSchema>;
export type CreateLabelInput = z.infer<typeof createLabelSchema>;
export type TicketsListQuery = z.infer<typeof ticketsListQuerySchema>;
export type AllWorkQuery = z.infer<typeof allWorkQuerySchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;
export type ReorderInput = z.infer<typeof reorderSchema>;
export type CommentInput = z.infer<typeof commentSchema>;
export type AddRelationInput = z.infer<typeof addRelationSchema>;
export type AddWatcherInput = z.infer<typeof addWatcherSchema>;
export type AddLabelInput = z.infer<typeof addLabelSchema>;
export type AttachmentInput = z.infer<typeof attachmentSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;
export type BurnupQuery = z.infer<typeof burnupQuerySchema>;
export type CfdQuery = z.infer<typeof cfdQuerySchema>;
export type RoadmapListQuery = z.infer<typeof roadmapListQuerySchema>;
export type CreateRoadmapInput = z.infer<typeof createRoadmapSchema>;
export type UpdateRoadmapInput = z.infer<typeof updateRoadmapSchema>;
export type FeedbackListQuery = z.infer<typeof feedbackListQuerySchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackSchema>;
export type ChangelogListQuery = z.infer<typeof changelogListQuerySchema>;
export type CreateChangelogInput = z.infer<typeof createChangelogSchema>;
export type UpdateChangelogInput = z.infer<typeof updateChangelogSchema>;

export const updateCommentSchema = z.object({ content: z.string().min(1) });
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

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

export type ImportTicketRow = z.infer<typeof importTicketRowSchema>;
export type ImportTicketsInput = z.infer<typeof importTicketsSchema>;

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

export const linkManagedProductSchema = z.object({
  managedProductId: z.number().int().positive().nullable(),
});
export type LinkManagedProductInput = z.infer<typeof linkManagedProductSchema>;
