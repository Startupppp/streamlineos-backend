import { z } from "zod";

export const ticketStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]);
export const ticketPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const listTicketsSchema = z.object({
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeId: z.string().optional(),
  queueId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createTicketSchema = z.object({
  title: z
    .string()
    .trim()
    .min(5, "Title must be at least 5 characters")
    .max(150, "Title must be at most 150 characters")
    .refine((v) => !/\s{2,}/.test(v), "Title cannot have multiple consecutive spaces")
    .refine((v) => !/^[\W\s]+$/.test(v), "Title cannot consist of only special characters")
    .refine((v) => /[a-zA-Z0-9]/.test(v), "Title must contain at least one letter or number")
    .refine((v) => !/[<>{}|\\^`]/.test(v), "Title contains invalid characters"),
  category: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  clientId: z.number().optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeId: z.string().optional(),
});

export const updateTicketSchema = z.object({
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeId: z.string().optional(),
  queueId: z.number().int().positive().nullable().optional(),
  expectedUpdatedAt: z.coerce.date().optional(),
});

const TICKET_ATTACHMENT_MAX_FILE_SIZE = 10 * 1024 * 1024;

const TICKET_ATTACHMENT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
] as const;

export const replyMessageSchema = z.object({
  body: z.string().min(1),
  isInternal: z.boolean().default(false),
  attachments: z
    .array(
      z.object({
        fileName: z.string().trim().min(1, "File name is required").max(255),
        fileUrl: z.string().trim().min(1).max(2048),
        fileSize: z
          .number()
          .int()
          .positive()
          .max(TICKET_ATTACHMENT_MAX_FILE_SIZE, "File too large (max 10MB)"),
        mimeType: z.enum(TICKET_ATTACHMENT_ALLOWED_MIME_TYPES, {
          message: "Unsupported file type. Allowed: PDF, images, Word, Excel, plain text, CSV.",
        }),
      }),
    )
    .max(10, "Too many attachments")
    .optional(),
});

export const listMacrosSchema = z.object({
  category: z.string().trim().optional(),
  search: z.string().trim().optional(),
});

export const createMacroSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(150),
  body: z.string().trim().min(1, "Body is required").max(10000),
  category: z.string().trim().max(100).optional(),
});

export const updateMacroSchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
  category: z.string().trim().max(100).nullable().optional(),
});

const routingConditionSchema = z.object({
  field: z.string().trim().min(1).max(50),
  op: z.enum(["eq", "neq", "contains"]),
  value: z.string().trim().min(1).max(200),
});

export const createRoutingRuleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  conditions: z.array(routingConditionSchema).min(1, "At least one condition is required"),
  assigneeId: z.string().trim().min(1).optional(),
  setPriority: ticketPrioritySchema.optional(),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
});

export const updateRoutingRuleSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  conditions: z.array(routingConditionSchema).min(1).optional(),
  assigneeId: z.string().trim().min(1).nullable().optional(),
  setPriority: ticketPrioritySchema.nullable().optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createQueueSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500).optional(),
  filter: z.record(z.string(), z.unknown()).default({}),
  sortOrder: z.number().int().min(0).default(0),
  isDefault: z.boolean().default(false),
});

export const updateQueueSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
});

export const savedViewVisibilitySchema = z.enum(["personal", "team", "global"]);

export const createSavedViewSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  filter: z.record(z.string(), z.unknown()).default({}),
  visibility: savedViewVisibilitySchema.default("personal"),
  sortOrder: z.number().int().min(0).default(0),
});

export const updateSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  visibility: savedViewVisibilitySchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createTagSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(50),
  color: z.string().trim().max(20).optional(),
});

export const ticketLinkRelationSchema = z.enum(["duplicate", "related"]);

export const createTicketLinkSchema = z.object({
  linkedTicketId: z.number().int().positive(),
  relation: ticketLinkRelationSchema,
});

export const mergeTicketSchema = z.object({
  intoTicketId: z.number().int().positive(),
});

export const createKbCategorySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  icon: z.string().max(100).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
});

export const updateKbCategorySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
});

export const listKbArticlesSchema = z.object({
  status: z.enum(["draft", "published", "archived"]).optional(),
  visibility: z.enum(["public", "internal"]).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export const createKbArticleSchema = z.object({
  title: z.string().min(1).max(300),
  categoryId: z.number().int().positive().nullable().optional(),
  excerpt: z.string().max(500).optional(),
  content: z.string().optional(),
  status: z.enum(["draft", "published", "archived"]).default("draft"),
  visibility: z.enum(["public", "internal"]).default("internal"),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

export const updateKbArticleSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  excerpt: z.string().max(500).nullable().optional(),
  content: z.string().optional(),
  status: z.enum(["draft", "published", "archived"]).optional(),
  visibility: z.enum(["public", "internal"]).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).nullable().optional(),
});

export const createKbCommentSchema = z.object({
  body: z.string().trim().min(1, "Comment cannot be empty").max(5000),
});

const KB_ATTACHMENT_MAX_FILE_SIZE = 10 * 1024 * 1024;

const KB_ATTACHMENT_ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const createKbAttachmentSchema = z.object({
  fileName: z.string().trim().min(1, "File name is required").max(255),
  fileKey: z.string().trim().min(1, "File key is required").max(1024),
  fileUrl: z.string().trim().max(2048).optional(),
  fileSize: z.number().int().positive().max(KB_ATTACHMENT_MAX_FILE_SIZE, "File too large (max 10MB)"),
  mimeType: z.enum(KB_ATTACHMENT_ALLOWED_MIME_TYPES, {
    message: "Unsupported file type. Allowed: PDF, images, Word, Excel.",
  }),
});

export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export type ListTicketsInput = z.infer<typeof listTicketsSchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type ReplyMessageInput = z.infer<typeof replyMessageSchema>;
export type ListMacrosInput = z.infer<typeof listMacrosSchema>;
export type CreateMacroInput = z.infer<typeof createMacroSchema>;
export type UpdateMacroInput = z.infer<typeof updateMacroSchema>;
export type CreateRoutingRuleInput = z.infer<typeof createRoutingRuleSchema>;
export type UpdateRoutingRuleInput = z.infer<typeof updateRoutingRuleSchema>;
export type CreateQueueInput = z.infer<typeof createQueueSchema>;
export type UpdateQueueInput = z.infer<typeof updateQueueSchema>;
export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;
export type CreateTagInput = z.infer<typeof createTagSchema>;
export type CreateTicketLinkInput = z.infer<typeof createTicketLinkSchema>;
export type MergeTicketInput = z.infer<typeof mergeTicketSchema>;
export type CreateKbCategoryInput = z.infer<typeof createKbCategorySchema>;
export type UpdateKbCategoryInput = z.infer<typeof updateKbCategorySchema>;
export type ListKbArticlesInput = z.infer<typeof listKbArticlesSchema>;
export type CreateKbArticleInput = z.infer<typeof createKbArticleSchema>;
export type UpdateKbArticleInput = z.infer<typeof updateKbArticleSchema>;
export type CreateKbCommentInput = z.infer<typeof createKbCommentSchema>;
export type CreateKbAttachmentInput = z.infer<typeof createKbAttachmentSchema>;

export const kbAskSchema = z.object({
  question: z.string().trim().min(3, "Question is too short").max(1000),
  articleId: z.number().int().positive().optional(),
});
export type KbAskInput = z.infer<typeof kbAskSchema>;
