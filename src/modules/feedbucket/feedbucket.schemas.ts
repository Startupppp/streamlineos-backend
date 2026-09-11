import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../common/pagination/list-query.schema";

const feedbucketMetadataSchema = z
  .object({
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
  })
  .optional();

const feedbucketConsoleEntrySchema = z.object({
  level: z.string(),
  message: z.string(),
  ts: z.number().optional(),
});

const feedbucketNetworkEntrySchema = z.object({
  method: z.string().max(16),
  url: z.string().max(2048),
  status: z.number().int().min(0).max(999),
  statusText: z.string().max(200),
  durationMs: z.number().min(0),
  startedAt: z.string().max(64),
  type: z.enum(["xhr", "fetch"]),
  ok: z.boolean(),
  error: z.string().max(500).optional(),
});

export const createWidgetSchema = z.object({
  name: z.string().min(1).max(100),
  projectId: z.number().int().positive().nullable().optional(),
  allowedDomains: z.array(z.string()).optional(),
  autoCreateTicket: z.boolean().optional(),
  aiAssistEnabled: z.boolean().optional(),
  defaultTicketType: z.string().optional(),
  theme: z
    .object({
      color: z.string().optional(),
      position: z.enum(["bottom-right", "bottom-left"]).optional(),
      label: z.string().optional(),
    })
    .optional(),
}).strict();

export const updateWidgetSchema = createWidgetSchema.partial().extend({
  isActive: z.boolean().optional(),
}).strict();

export const listSubmissionsQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20, 100),
  widgetId: z.coerce.number().int().positive().optional(),
  type: z.enum(["bug", "idea", "feature", "question", "praise", "other"]).optional(),
  status: z.enum(["open", "in_progress", "resolved", "archived"]).optional(),
  assigneeId: z.string().optional(),
  search: z.string().optional(),
}).strict();

export const updateSubmissionSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "archived"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().nullable().optional(),
}).strict();

export const publicSubmitSchema = z.object({
  type: z.enum(["bug", "idea", "feature", "question", "praise", "other"]),
  message: z.string().min(1).max(5000),
  pageUrl: z.string().url().max(2048).optional(),
  reporterName: z.string().max(100).optional(),
  reporterEmail: z.string().email().optional(),
  metadata: feedbucketMetadataSchema,
  consoleLogs: z.array(feedbucketConsoleEntrySchema).max(50).optional(),
  networkLogs: z.array(feedbucketNetworkEntrySchema).max(50).optional(),
});

export const publicAiAssistSchema = z.object({
  type: z.enum(["bug", "idea", "feature", "question", "praise", "other"]).optional(),
  message: z.string().max(5000).optional(),
  pageUrl: z.string().url().max(2048).optional(),
  networkLogs: z.array(feedbucketNetworkEntrySchema).max(50).optional(),
});

export const publicSubmitDeclSchema = publicSubmitSchema.partial().strict().default({});
export const publicAiAssistDeclSchema = publicAiAssistSchema.partial().strict().default({});

export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;
export type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>;
export type ListSubmissionsQuery = z.infer<typeof listSubmissionsQuerySchema>;
export type UpdateSubmissionInput = z.infer<typeof updateSubmissionSchema>;
export type PublicSubmitInput = z.infer<typeof publicSubmitSchema>;
