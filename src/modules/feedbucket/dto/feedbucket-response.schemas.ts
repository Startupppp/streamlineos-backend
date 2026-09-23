import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import {
  cursorPageSchema,
  successSchema,
} from "../../../common/openapi/response-envelopes";

const feedbucketWidgetThemeSchema = z.object({
  color: z.string().optional(),
  position: z.enum(["bottom-right", "bottom-left"]).optional(),
  label: z.string().optional(),
});

const feedbucketAssigneeRulesSchema = z.object({
  bug: z.number().int().optional(),
  idea: z.number().int().optional(),
  feature: z.number().int().optional(),
  question: z.number().int().optional(),
  praise: z.number().int().optional(),
  other: z.number().int().optional(),
});

export const feedbucketWidgetRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  projectId: z.number().int().nullable(),
  managedProductId: z.number().int().nullable(),
  defaultProjectId: z.number().int().nullable(),
  defaultAssigneeMembershipId: z.number().int().nullable(),
  assigneeRules: feedbucketAssigneeRulesSchema.nullable(),
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

const feedbucketMetadataSchema = z.object({
  browser: z.string().optional(),
  browserVersion: z.string().optional(),
  os: z.string().optional(),
  device: z.string().optional(),
  screenW: z.number().optional(),
  screenH: z.number().optional(),
  viewportW: z.number().optional(),
  viewportH: z.number().optional(),
  userAgent: z.string().optional(),
  language: z.string().optional(),
  referrer: z.string().optional(),
});

const feedbucketConsoleEntrySchema = z.object({
  level: z.string(),
  message: z.string(),
  ts: z.number().optional(),
});

const feedbucketNetworkEntrySchema = z.object({
  method: z.string(),
  url: z.string(),
  status: z.number(),
  statusText: z.string(),
  durationMs: z.number(),
  startedAt: z.string(),
  type: z.enum(["xhr", "fetch"]),
  ok: z.boolean(),
  error: z.string().optional(),
});

const feedbucketAiAnalysisSchema = z.object({
  type: z.enum(["bug", "feature", "improvement", "question", "praise", "other"]),
  confidence: z.number(),
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
});

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
  metadata: feedbucketMetadataSchema.nullable(),
  consoleLogs: z.array(feedbucketConsoleEntrySchema).nullable().optional(),
  networkLogs: z.array(feedbucketNetworkEntrySchema).nullable().optional(),
  reporterName: z.string().nullable(),
  reporterEmail: z.string().nullable(),
  crmContactId: z.number().int().nullable(),
  crmOrganizationId: z.number().int().nullable(),
  accountValueSnapshot: z.string().nullable(),
  assigneeMembershipId: z.number().int().nullable(),
  linkedTicketId: z.number().int().nullable(),
  aiType: z.string().nullable(),
  aiConfidence: z.number().int().nullable(),
  aiAnalysis: feedbucketAiAnalysisSchema.nullable(),
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

export const feedbucketSubmissionListSchema = cursorPageSchema(
  feedbucketSubmissionRowSchema.and(
    z.object({ widget: feedbucketWidgetRowSchema.nullable() }),
  ),
).extend({
  page: z.number().int().optional(),
  total: z.number().int().optional(),
  totalPages: z.number().int().optional(),
});

export const feedbucketBulkSubmissionsSchema = z.object({
  requested: z.number().int(),
  succeeded: z.number().int(),
  skipped: z.number().int(),
  results: z.array(
    z.object({
      submissionId: z.number().int(),
      outcome: z.enum(["updated", "deleted", "skipped"]),
      reason: z.enum(["not_found_or_filtered"]).nullable(),
    }),
  ),
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
  ticketType: z.enum(["EPIC", "BUG", "STORY", "TASK"]),
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
