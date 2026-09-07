import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { successSchema } from "../../../common/openapi/response-envelopes";

const feedbucketWidgetThemeSchema = z.object({
  color: z.string().optional(),
  position: z.enum(["bottom-right", "bottom-left"]).optional(),
  label: z.string().optional(),
});

export const feedbucketWidgetRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int().nullable(),
  managedProductId: z.number().int().nullable(),
  name: z.string(),
  publicKey: z.string(),
  allowedDomains: z.array(z.string()),
  autoCreateTicket: z.boolean(),
  defaultTicketType: z.string(),
  isActive: z.boolean(),
  aiAssistEnabled: z.boolean(),
  theme: feedbucketWidgetThemeSchema.nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const projectMinimalSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  key: z.string(),
  orgId: z.string(),
});

export const feedbucketWidgetWithProjectSchema = feedbucketWidgetRowSchema.and(
  z.object({
    project: projectMinimalSchema.nullable(),
  }),
);

export const feedbucketWidgetListItemSchema = feedbucketWidgetWithProjectSchema.and(
  z.object({
    submissionCount: z.number().int(),
    openCount: z.number().int(),
  }),
);

export const feedbucketWidgetListSchema = z.array(feedbucketWidgetListItemSchema);

export const feedbucketRotateKeySchema = z.object({ publicKey: z.string() });

export const feedbucketSubmissionRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  widgetId: z.number().int(),
  type: z.enum(["bug", "idea", "feature", "question", "praise", "other"]),
  status: z.enum(["open", "in_progress", "resolved", "archived"]),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable(),
  message: z.string(),
  pageUrl: z.string().nullable(),
  screenshotUrl: z.string().nullable(),
  screenshotKey: z.string().nullable(),
  metadata: z.unknown().nullable(),
  consoleLogs: z.unknown().nullable().optional(),
  networkLogs: z.unknown().nullable().optional(),
  reporterName: z.string().nullable(),
  reporterEmail: z.string().nullable(),
  crmContactId: z.number().int().nullable(),
  crmOrganizationId: z.number().int().nullable(),
  accountValueSnapshot: z.string().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  linkedTicketId: z.number().int().nullable(),
  aiType: z.string().nullable(),
  aiConfidence: z.number().int().nullable(),
  aiAnalysis: z.unknown().nullable(),
  aiModel: z.string().nullable(),
  aiProcessedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

const linkedTicketMinimalSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
});

export const feedbucketSubmissionDetailSchema = feedbucketSubmissionRowSchema.and(
  z.object({
    widget: feedbucketWidgetRowSchema.nullable(),
    linkedTicket: linkedTicketMinimalSchema.nullable(),
    recordingUrl: z.string().nullable(),
  }),
);

export const feedbucketSubmissionListSchema = z.object({
  data: z.array(
    feedbucketSubmissionRowSchema.and(z.object({ widget: feedbucketWidgetRowSchema.nullable() })),
  ),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
  totalPages: z.number().int(),
});

export const feedbucketConvertTicketSchema = z.object({ ticketId: z.number().int() });

const aiUsageMetaSchema = z.object({
  model: z.string(),
  promptTokens: z.number().int(),
  completionTokens: z.number().int(),
  totalTokens: z.number().int(),
  credits: z.number(),
  costUsd: z.number(),
});

export const feedbucketFeedbackAnalysisSchema = z.object({
  type: z.enum(["bug", "feature", "improvement", "question", "praise", "other"]),
  confidence: z.number().int().min(0).max(100),
  suggestedTicketType: z.enum(["EPIC", "BUG", "STORY", "TASK"]),
  title: z.string(),
  summary: z.string(),
  description: z.string(),
  reproductionSteps: z.array(z.string()),
  suggestions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
  model: z.string(),
  processedAt: z.string(),
  aiUsage: aiUsageMetaSchema.optional(),
});

export const feedbucketCreateTicketFromAnalysisSchema = z.object({
  ticketId: z.number().int(),
  ticketType: z.string(),
});

export const feedbucketStatsSchema = z.object({
  byStatus: z.record(z.string(), z.number()),
  byType: z.record(z.string(), z.number()),
});

export const feedbucketPublicConfigSchema = z.object({
  name: z.string(),
  theme: feedbucketWidgetThemeSchema.nullable(),
  defaultTicketType: z.string(),
  aiAssistEnabled: z.boolean(),
});

export const feedbucketPublicSubmitSchema = z.object({ ok: z.literal(true) });

export const feedbucketPublicAiAssistSchema = z.object({
  suggestedType: z.string(),
  title: z.string(),
  description: z.string(),
});

export { successSchema };
