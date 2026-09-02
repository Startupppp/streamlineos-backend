import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const ticketStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]);
export const ticketPrioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const customFieldTypeSchema = z.enum(["text", "number", "select", "checkbox", "date"]);

export const createCustomFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "Key is required")
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, "Key must be lowercase snake_case, e.g. order_number"),
  label: z.string().trim().min(1, "Label is required").max(150),
  fieldType: customFieldTypeSchema,
  options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  required: z.boolean().default(false),
  category: z.string().trim().max(100).optional(),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
}).strict();

export const updateCustomFieldSchema = z.object({
  label: z.string().trim().min(1).max(150).optional(),
  options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  required: z.boolean().optional(),
  category: z.string().trim().max(100).nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
}).strict();

export const customFieldValueSchema = z.object({
  fieldId: z.number().int().positive(),
  value: z.string().trim().max(2000).nullable(),
});

export const listTicketsSchema = z.object({
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeId: z.string().optional(),
  queueId: z.coerce.number().int().positive().optional(),
  channel: z.string().trim().optional(),
  snoozed: z.enum(["true", "false"]).optional().transform((v) => (v === undefined ? undefined : v === "true")),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();

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
  customFields: z.array(customFieldValueSchema).max(50).optional(),
}).strict();

export const updateTicketSchema = z.object({
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  assigneeId: z.string().optional(),
  queueId: z.number().int().positive().nullable().optional(),
  expectedUpdatedAt: z.coerce.date().optional(),
  customFields: z.array(customFieldValueSchema).max(50).optional(),
}).strict();

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
}).strict();

export const listMacrosSchema = z.object({
  category: z.string().trim().optional(),
  search: z.string().trim().optional(),
}).strict();

const macroVisibilitySchema = z.enum(["org", "team", "private"]);

const macroActionsSchema = z.object({
  setStatus: ticketStatusSchema.optional(),
  setPriority: ticketPrioritySchema.optional(),
  addTagId: z.number().int().positive().optional(),
  isInternal: z.boolean().optional(),
});

export const createMacroSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(150),
  body: z.string().trim().min(1, "Body is required").max(10000),
  category: z.string().trim().max(100).optional(),
  visibility: macroVisibilitySchema.default("org"),
  actions: macroActionsSchema.default({}),
}).strict();

export const updateMacroSchema = z.object({
  title: z.string().trim().min(1).max(150).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
  category: z.string().trim().max(100).nullable().optional(),
  visibility: macroVisibilitySchema.optional(),
  actions: macroActionsSchema.optional(),
}).strict();

export const applyMacroSchema = z.object({
  ticketId: z.number().int().positive(),
}).strict();

const routingConditionSchema = z.object({
  field: z.string().trim().min(1).max(50),
  op: z.enum(["eq", "neq", "contains"]),
  value: z.string().trim().min(1).max(200),
});

export const assignmentModeSchema = z.enum([
  "static",
  "round_robin",
  "load_balanced",
  "skill_based",
  "availability_based",
]);

export const createRoutingRuleSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  conditions: z.array(routingConditionSchema).min(1, "At least one condition is required"),
  assigneeId: z.string().trim().min(1).optional(),
  setPriority: ticketPrioritySchema.optional(),
  assignmentMode: assignmentModeSchema.default("static"),
  candidateAgentIds: z.array(z.string().trim().min(1)).max(50).default([]),
  requiredSkills: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(0),
}).strict();

export const updateRoutingRuleSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  conditions: z.array(routingConditionSchema).min(1).optional(),
  assigneeId: z.string().trim().min(1).nullable().optional(),
  setPriority: ticketPrioritySchema.nullable().optional(),
  assignmentMode: assignmentModeSchema.optional(),
  candidateAgentIds: z.array(z.string().trim().min(1)).max(50).optional(),
  requiredSkills: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  isEnabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
}).strict();

export const setAgentSkillsSchema = z.object({
  skills: z.array(z.string().trim().min(1).max(50)).max(50),
}).strict();

export const setAgentAvailabilitySchema = z.object({
  isAvailable: z.boolean(),
}).strict();

export const addVipClientSchema = z.object({
  clientId: z.coerce.number().int().positive(),
}).strict();

export const createQueueSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(500).optional(),
  filter: z.record(z.string(), z.unknown()).default({}),
  sortOrder: z.number().int().min(0).default(0),
  isDefault: z.boolean().default(false),
}).strict();

export const updateQueueSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
}).strict();

export const savedViewVisibilitySchema = z.enum(["personal", "team", "global"]);

export const createSavedViewSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  filter: z.record(z.string(), z.unknown()).default({}),
  visibility: savedViewVisibilitySchema.default("personal"),
  sortOrder: z.number().int().min(0).default(0),
}).strict();

export const updateSavedViewSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  visibility: savedViewVisibilitySchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
}).strict();

export const createTagSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(50),
  color: z.string().trim().max(20).optional(),
}).strict();

export const ticketLinkRelationSchema = z.enum(["duplicate", "related", "split"]);

export const createTicketLinkSchema = z.object({
  linkedTicketId: z.number().int().positive(),
  relation: ticketLinkRelationSchema,
}).strict();

export const mergeTicketSchema = z.object({
  intoTicketId: z.number().int().positive(),
}).strict();

export const snoozeTicketSchema = z.object({
  snoozedUntil: z.coerce.date().refine((d) => d.getTime() > Date.now(), "Snooze date must be in the future"),
}).strict();

export const externalEntityTypeSchema = z.enum(["project", "invoice", "calendar_event", "chat_channel"]);

export const createExternalLinkSchema = z.object({
  entityType: externalEntityTypeSchema,
  entityId: z.number().int().positive(),
}).strict();

export const splitTicketSchema = z.object({
  title: z
    .string()
    .trim()
    .min(5, "Title must be at least 5 characters")
    .max(150, "Title must be at most 150 characters"),
  description: z.string().max(5000).optional(),
}).strict();

export const upsertDraftSchema = z.object({
  body: z.string().max(10000),
  isInternal: z.boolean().default(false),
}).strict();

export const PORTAL_TICKET_CATEGORIES = [
  "general",
  "billing",
  "bug_report",
  "feature_request",
  "onboarding",
  "internal_it",
] as const;

export const createPortalTicketSchema = z.object({
  title: z
    .string()
    .trim()
    .min(5, "Title must be at least 5 characters")
    .max(150, "Title must be at most 150 characters"),
  category: z.enum(PORTAL_TICKET_CATEGORIES).default("general"),
  description: z.string().trim().min(1, "Description is required").max(5000),
  attachments: z
    .array(
      z.object({
        fileName: z.string().trim().min(1).max(255),
        fileUrl: z.string().trim().min(1).max(2048),
        fileSize: z.number().int().positive().max(TICKET_ATTACHMENT_MAX_FILE_SIZE),
        mimeType: z.enum(TICKET_ATTACHMENT_ALLOWED_MIME_TYPES),
      }),
    )
    .max(5)
    .optional(),
  customFields: z.array(customFieldValueSchema).max(50).optional(),
}).strict();

export const createPortalMessageSchema = z.object({
  body: z.string().trim().min(1, "Message is required").max(5000),
  attachments: z
    .array(
      z.object({
        fileName: z.string().trim().min(1).max(255),
        fileUrl: z.string().trim().min(1).max(2048),
        fileSize: z.number().int().positive().max(TICKET_ATTACHMENT_MAX_FILE_SIZE),
        mimeType: z.enum(TICKET_ATTACHMENT_ALLOWED_MIME_TYPES),
      }),
    )
    .max(5)
    .optional(),
}).strict();

export const supportChannelTypeSchema = z.enum(["email", "chat", "whatsapp", "sms"]);

export const createSupportChannelSchema = z.object({
  type: supportChannelTypeSchema,
  name: z.string().trim().min(1, "Name is required").max(100),
  config: z.record(z.string(), z.unknown()).default({}),
  isActive: z.boolean().default(true),
}).strict();

export const updateSupportChannelSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  rotateInboundSecret: z.boolean().optional(),
}).strict();

export const inboundEmailSchema = z.object({
  messageId: z.string().trim().min(1, "messageId is required").max(998),
  inReplyTo: z.string().trim().max(998).optional(),
  fromEmail: z.string().trim().email().max(320),
  fromName: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(998).optional(),
  bodyText: z.string().max(50_000),
  attachments: z
    .array(
      z.object({
        fileName: z.string().trim().min(1).max(255),
        fileUrl: z.string().trim().min(1).max(2048),
        fileSize: z.number().int().positive().max(TICKET_ATTACHMENT_MAX_FILE_SIZE),
        mimeType: z.enum(TICKET_ATTACHMENT_ALLOWED_MIME_TYPES),
      }),
    )
    .max(10)
    .optional(),
}).strict();

export const inboundWhatsAppSchema = z.object({
  messageId: z.string().trim().min(1, "messageId is required").max(998),
  inReplyTo: z.string().trim().max(998).optional(),
  from: z.string().trim().min(1, "from is required").max(32),
  fromName: z.string().trim().max(200).optional(),
  bodyText: z.string().max(4096),
}).strict();

export const inboundSmsSchema = z.object({
  messageId: z.string().trim().min(1, "messageId is required").max(998),
  from: z.string().trim().min(1, "from is required").max(32),
  bodyText: z.string().max(1600),
}).strict();

export const startChatSessionSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().email().max(320).optional(),
  message: z.string().trim().min(1, "Message is required").max(4000),
}).strict();

export const sendChatMessageSchema = z.object({
  body: z.string().trim().min(1, "Message is required").max(4000),
}).strict();

export const submitCsatSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
}).strict();

export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export type ListTicketsInput = z.infer<typeof listTicketsSchema>;
export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type ReplyMessageInput = z.infer<typeof replyMessageSchema>;
export type ListMacrosInput = z.infer<typeof listMacrosSchema>;
export type CreateMacroInput = z.infer<typeof createMacroSchema>;
export type UpdateMacroInput = z.infer<typeof updateMacroSchema>;
export type ApplyMacroInput = z.infer<typeof applyMacroSchema>;
export type SubmitCsatInput = z.infer<typeof submitCsatSchema>;
export type CreateRoutingRuleInput = z.infer<typeof createRoutingRuleSchema>;
export type SetAgentSkillsInput = z.infer<typeof setAgentSkillsSchema>;
export type SetAgentAvailabilityInput = z.infer<typeof setAgentAvailabilitySchema>;
export type AddVipClientInput = z.infer<typeof addVipClientSchema>;
export type UpdateRoutingRuleInput = z.infer<typeof updateRoutingRuleSchema>;
export type CreatePortalTicketInput = z.infer<typeof createPortalTicketSchema>;
export type CreatePortalMessageInput = z.infer<typeof createPortalMessageSchema>;
export type CreateSupportChannelInput = z.infer<typeof createSupportChannelSchema>;
export type UpdateSupportChannelInput = z.infer<typeof updateSupportChannelSchema>;
export type InboundEmailInput = z.infer<typeof inboundEmailSchema>;
export type InboundWhatsAppInput = z.infer<typeof inboundWhatsAppSchema>;
export type InboundSmsInput = z.infer<typeof inboundSmsSchema>;
export type StartChatSessionInput = z.infer<typeof startChatSessionSchema>;
export type SendChatMessageInput = z.infer<typeof sendChatMessageSchema>;
export type CreateQueueInput = z.infer<typeof createQueueSchema>;
export type UpdateQueueInput = z.infer<typeof updateQueueSchema>;
export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;
export type CreateTagInput = z.infer<typeof createTagSchema>;
export type CreateTicketLinkInput = z.infer<typeof createTicketLinkSchema>;
export type MergeTicketInput = z.infer<typeof mergeTicketSchema>;
export type CreateExternalLinkInput = z.infer<typeof createExternalLinkSchema>;
export type SnoozeTicketInput = z.infer<typeof snoozeTicketSchema>;
export type SplitTicketInput = z.infer<typeof splitTicketSchema>;
export type UpsertDraftInput = z.infer<typeof upsertDraftSchema>;
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;
export type CustomFieldValueInput = z.infer<typeof customFieldValueSchema>;
