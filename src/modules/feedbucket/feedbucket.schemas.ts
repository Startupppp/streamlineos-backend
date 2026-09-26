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

const feedbucketAssigneeRulesSchema = z.object({
  bug: z.string().min(1).optional(),
  idea: z.string().min(1).optional(),
  feature: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  praise: z.string().min(1).optional(),
  other: z.string().min(1).optional(),
}).strict();

export const createWidgetSchema = z.object({
  name: z.string().min(1).max(100),
  projectId: z.number().int().positive().nullable().optional(),
  defaultProjectId: z.number().int().positive().nullable().optional(),
  defaultAssigneeId: z.string().min(1).nullable().optional(),
  assigneeRules: feedbucketAssigneeRulesSchema.nullable().optional(),
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

export const convertToTicketSchema = z.object({
  projectId: z.number().int().positive().optional(),
  assigneeId: z.string().min(1).optional(),
}).strict();

export type ConvertToTicketInput = z.infer<typeof convertToTicketSchema>;

export const feedbucketSubmissionTypeSchema = z.enum([
  "bug",
  "idea",
  "feature",
  "question",
  "praise",
  "other",
]);
export const feedbucketSubmissionStatusSchema = z.enum([
  "open",
  "in_progress",
  "resolved",
  "archived",
]);
export const feedbucketSubmissionPrioritySchema = z.enum([
  "low",
  "medium",
  "high",
  "urgent",
]);

export const submissionFiltersSchema = z.object({
  widgetId: z.coerce.number().int().positive().optional(),
  managedProductId: z.coerce.number().int().positive().optional(),
  type: feedbucketSubmissionTypeSchema.optional(),
  status: feedbucketSubmissionStatusSchema.optional(),
  assigneeId: z.string().optional(),
  search: z.string().optional(),
  linked: z.enum(["linked", "unlinked"]).optional(),
  duplicate: z.enum(["true", "false"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export type SubmissionFilters = z.infer<typeof submissionFiltersSchema>;

function refineDateWindow(
  val: { from?: string; to?: string },
  ctx: z.RefinementCtx,
): void {
  if (val.from !== undefined && val.to !== undefined && new Date(val.from) >= new Date(val.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "'from' must be before 'to'", path: ["from"] });
  }
}

export const listSubmissionsQuerySchema = submissionFiltersSchema
  .extend({
    page: pageNumberField,
    limit: pageSizeField(20, 100),
    cursor: z.string().min(1).optional(),
  })
  .strict()
  .superRefine(refineDateWindow);

export const FEEDBUCKET_BULK_MAX = 100;

export const bulkSubmissionsSchema = z.object({
  submissionIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(FEEDBUCKET_BULK_MAX),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("status"), status: feedbucketSubmissionStatusSchema }).strict(),
    z.object({ type: z.literal("priority"), priority: feedbucketSubmissionPrioritySchema }).strict(),
    z.object({ type: z.literal("assign"), assigneeId: z.string().min(1).nullable() }).strict(),
    z.object({ type: z.literal("delete") }).strict(),
  ]),
  filters: submissionFiltersSchema.strict().superRefine(refineDateWindow).optional(),
}).strict();

export type BulkSubmissionsInput = z.infer<typeof bulkSubmissionsSchema>;

export const updateSubmissionSchema = z.object({
  status: feedbucketSubmissionStatusSchema.optional(),
  priority: feedbucketSubmissionPrioritySchema.optional(),
  assigneeId: z.string().nullable().optional(),
}).strict();

export const feedbucketMediaKindSchema = z.enum(["screenshot", "recording"]);

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
export type FeedbucketMediaKind = z.infer<typeof feedbucketMediaKindSchema>;
export type PublicSubmitInput = z.infer<typeof publicSubmitSchema>;
