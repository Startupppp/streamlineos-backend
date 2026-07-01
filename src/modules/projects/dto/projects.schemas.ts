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

export const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  key: z.string().optional(),
  managerId: z.string().optional(),
  clientId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  memberIds: z.array(z.string()).optional(),
  modules: projectModulesSchema.optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
  managerId: z.string().optional(),
  clientId: z.string().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  memberIds: z.array(z.string()).optional(),
  reassignments: z.record(z.string(), z.string()).optional(),
});

export const updateBudgetSchema = z.object({
  budget: z.number().min(0),
});

export const fromDealSchema = z.object({
  dealId: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const addMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.string().default("CONTRIBUTOR"),
});

export const removeMemberSchema = z.object({
  userId: z.string().min(1),
});

export const createStateSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  group: z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]),
  sequence: z.number().int().min(0),
  isDefault: z.boolean().default(false),
});

export const updateCustomStateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  group: z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]).optional(),
  sequence: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
});

export const createLabelSchema = z.object({
  name: z.string().min(1, "Label name is required"),
  color: z.string().optional(),
});

export const updateLabelSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

export const ticketsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

export const searchTicketsQuerySchema = z.object({
  q: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});
export type SearchTicketsQuery = z.infer<typeof searchTicketsQuerySchema>;

export const createTicketSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(["TASK", "BUG", "STORY", "EPIC", "SUBTASK"]).default("TASK"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  assigneeId: z.string().optional(),
  assigneeIds: z.array(z.string()).optional(),
  reporterId: z.string().optional(),
  sprintId: z.number().optional(),
  epicId: z.number().optional(),
  points: z.number().optional(),
  link: z.string().optional(),
  originalEstimate: z.number().optional(),
  parentTicketId: z.number().optional(),
  status: z.string().optional(),
});

export const updateTicketSchema = z.object({
  title: z.string().min(1).optional(),
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
});

export const bulkUpdateSchema = z
  .object({
    ticketIds: z.array(z.number().int().positive()).min(1),
    assigneeId: z.string().optional(),
    status: z.string().optional(),
    sprintId: z.number().int().positive().nullable().optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  })
  .refine(
    (data) =>
      data.assigneeId !== undefined ||
      data.status !== undefined ||
      data.sprintId !== undefined ||
      data.priority !== undefined,
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

export const commentSchema = z.object({ content: z.string().min(1) });

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

export const applyTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  managerId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const burnupQuerySchema = z.object({
  sprintId: z.string().regex(/^\d+$/).optional(),
});

export const cfdQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).default(30),
});

export const roadmapListQuerySchema = z.object({
  status: z.enum(["planned", "in_progress", "completed", "cancelled"]).optional(),
  search: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createRoadmapSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(["planned", "in_progress", "completed", "cancelled"]).default("planned"),
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
  status: z.enum(["planned", "in_progress", "completed", "cancelled"]).optional(),
  category: z.string().trim().max(100).nullable().optional(),
  isPublic: z.boolean().optional(),
  projectId: z.number().int().positive().nullable().optional(),
  epicTicketId: z.number().int().positive().nullable().optional(),
  targetQuarter: z.string().trim().max(20).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

export const feedbackListQuerySchema = z.object({
  status: z.enum(["open", "planned", "in_progress", "completed", "declined"]).optional(),
  search: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  status: z.enum(["open", "planned", "in_progress", "completed", "declined"]).default("open"),
  category: z.string().trim().max(100).optional(),
  submittedByName: z.string().trim().max(120).optional(),
  submittedByEmail: z.string().trim().email().optional(),
  linkedRoadmapItemId: z.number().int().positive().optional(),
});

export const updateFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  status: z.enum(["open", "planned", "in_progress", "completed", "declined"]).optional(),
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
