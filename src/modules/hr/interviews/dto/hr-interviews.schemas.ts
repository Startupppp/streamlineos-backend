import { z } from "zod";

export const upsertSlaSchema = z.object({
  stage: z.string().min(1),
  maxHours: z.number().int().positive(),
  warningHours: z.number().int().positive(),
});
export type UpsertSlaInput = z.infer<typeof upsertSlaSchema>;

export const interviewListSchema = z
  .object({
    candidateId: z.coerce.number().int().positive().optional(),
    upcoming: z.enum(["true", "false"]).optional(),
    relevant: z.enum(["true", "false"]).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
    /** @deprecated prefer page/pageSize */
    limit: z.coerce.number().int().min(1).max(200).optional(),
    /** @deprecated prefer page/pageSize */
    offset: z.coerce.number().int().min(0).optional(),
  })
  .transform((q) => {
    const pageSize = q.pageSize ?? q.limit ?? 20;
    const page =
      q.page ?? (q.offset != null ? Math.floor(q.offset / pageSize) + 1 : 1);
    return {
      candidateId: q.candidateId,
      upcoming: q.upcoming,
      relevant: q.relevant,
      page,
      pageSize,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    };
  });
export type InterviewListInput = z.output<typeof interviewListSchema>;

export const selfInterviewListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type SelfInterviewListInput = z.infer<typeof selfInterviewListSchema>;

export const hiringFlowListSchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(50),
  offset: z.coerce.number().min(0).default(0),
});
export type HiringFlowListInput = z.infer<typeof hiringFlowListSchema>;

export const createHiringFlowSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  isDefault: z.boolean().optional().default(false),
});
export type CreateHiringFlowInput = z.infer<typeof createHiringFlowSchema>;

export const updateHiringFlowSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateHiringFlowInput = z.infer<typeof updateHiringFlowSchema>;

const roundTypeEnum = z.enum([
  "HR_SCREENING",
  "TECHNICAL",
  "MANAGER",
  "CULTURAL_FIT",
  "FINAL",
  "CUSTOM",
]);
const roundModeEnum = z.enum(["VIDEO", "PHONE", "ONSITE"]);

export const createRoundSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  roundType: roundTypeEnum.default("CUSTOM"),
  mode: roundModeEnum.default("VIDEO"),
  durationMinutes: z.coerce.number().int().min(15).max(480).default(60),
  slaDays: z.coerce.number().int().min(1).max(30).optional(),
  questionBankTag: z.string().max(100).optional(),
  scorecardTemplateId: z.coerce.number().int().optional(),
  interviewerRoleRestriction: z.string().max(100).optional(),
  autoAdvanceThreshold: z.coerce.number().int().min(0).max(100).optional(),
});
export type CreateRoundInput = z.infer<typeof createRoundSchema>;

export const updateRoundSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  roundType: roundTypeEnum.optional(),
  mode: roundModeEnum.optional(),
  durationMinutes: z.coerce.number().int().min(15).max(480).optional(),
  slaDays: z.coerce.number().int().min(1).max(30).nullable().optional(),
  questionBankTag: z.string().max(100).nullable().optional(),
  scorecardTemplateId: z.coerce.number().int().nullable().optional(),
  interviewerRoleRestriction: z.string().max(100).nullable().optional(),
  autoAdvanceThreshold: z.coerce.number().int().min(0).max(100).nullable().optional(),
  orderIndex: z.coerce.number().int().min(0).optional(),
});
export type UpdateRoundInput = z.infer<typeof updateRoundSchema>;

export const createOfferTemplateSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  htmlContent: z.string().min(1),
  isDefault: z.boolean().optional().default(false),
});
export type CreateOfferTemplateInput = z.infer<typeof createOfferTemplateSchema>;

export const updateOfferTemplateSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  htmlContent: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateOfferTemplateInput = z.infer<typeof updateOfferTemplateSchema>;

export const generateOfferPdfSchema = z.object({
  candidateName: z.string().optional().default("Candidate"),
  designation: z.string().optional().default(""),
  salary: z.string().optional().default(""),
  joiningDate: z.string().optional().default(""),
  validUntil: z.string().optional().default(""),
  orgName: z.string().optional().default(""),
});
export type GenerateOfferPdfInput = z.infer<typeof generateOfferPdfSchema>;

export const offerLetterSchema = z.object({
  candidateId: z.number().int().positive(),
  jobPostingId: z.number().int().positive(),
  salary: z.string().min(1),
  startDate: z.string().min(1),
});
export type OfferLetterInput = z.infer<typeof offerLetterSchema>;

const criterionSchema = z.object({
  name: z.string().min(1),
  weight: z.number().min(0).max(100),
});

export const createScorecardTemplateSchema = z.object({
  name: z.string().min(1),
  criteria: z.array(criterionSchema).min(1),
  isBlindMode: z.boolean().optional(),
});
export type CreateScorecardTemplateInput = z.infer<typeof createScorecardTemplateSchema>;

export const updateScorecardTemplateSchema = z
  .object({
    name: z.string().min(1).max(200),
    criteria: z.array(criterionSchema).min(1),
  })
  .partial();
export type UpdateScorecardTemplateInput = z.infer<typeof updateScorecardTemplateSchema>;

export const scorecardAnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(90),
  jobId: z.coerce.number().int().positive().optional(),
  roundType: z.enum(["HR", "PHONE", "VIDEO", "ONSITE", "TECHNICAL", "FINAL"]).optional(),
});
export type ScorecardAnalyticsQueryInput = z.infer<typeof scorecardAnalyticsQuerySchema>;

const reportFiltersSchema = z.object({
  status: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  departmentId: z.string().uuid().optional(),
});

export const generateReportSchema = z.object({
  entity: z.enum(["candidates", "jobs", "interviews", "offers"]),
  fields: z.array(z.string()).min(1),
  filters: reportFiltersSchema.default({}),
});
export type GenerateReportInput = z.infer<typeof generateReportSchema>;

export const createScheduledReportSchema = z.object({
  name: z.string().min(1).max(200),
  reportConfig: z.object({
    entity: z.enum(["candidates", "jobs", "interviews", "offers"]),
    fields: z.array(z.string()).min(1),
    filters: reportFiltersSchema.default({}),
  }),
  schedule: z.enum(["WEEKLY", "MONTHLY"]),
  recipients: z.array(z.string().email()).min(1),
});
export type CreateScheduledReportInput = z.infer<typeof createScheduledReportSchema>;
