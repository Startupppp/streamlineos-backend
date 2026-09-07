import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const interviewSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  interviewerId: z.string().nullable(),
  interviewerMembershipId: z.number().int().nullable(),
  type: z.string().optional(),
  scheduledAt: wireDate(),
  duration: z.number().int(),
  location: z.string().nullable(),
  meetingLink: z.string().nullable(),
  result: z.string().optional(),
  feedback: z.string().nullable(),
  rating: z.number().int().nullable(),
  rubric: z.array(z.object({
    category: z.string(),
    score: z.number(),
    maxScore: z.number(),
    comment: z.string().optional(),
  })).nullable(),
  notes: z.string().nullable(),
  recordingUrl: z.string().nullable(),
  recordingPlatform: z.string().nullable(),
  remindersSent: z.record(z.string(), z.boolean()),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const interviewListResponseSchema = z.object({
  items: z.array(interviewSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const assignedInterviewItemSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  scheduledAt: wireDate(),
  duration: z.number().int(),
  location: z.string().nullable(),
  meetingLink: z.string().nullable(),
  result: z.enum(["PENDING", "PASSED", "FAILED", "NO_SHOW"]),
  candidateFirstName: z.string(),
  candidateLastName: z.string(),
  jobTitle: z.string().nullable(),
  scorecardSubmittedAt: nullableWireDate(),
});

export const assignedInterviewsPageSchema = z.object({
  items: z.array(assignedInterviewItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const interviewStatsSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
});

export const interviewSlaSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  stage: z.string(),
  maxHours: z.number().int(),
  warningHours: z.number().int(),
  createdAt: wireDate(),
});

export const slaReportStageDataSchema = z.object({
  stage: z.string(),
  total: z.number().int(),
  breached: z.number().int(),
  breachPct: z.number().int(),
});

export const slaReportMonthSchema = z.object({
  month: z.string(),
  label: z.string(),
  stages: z.array(slaReportStageDataSchema),
  overall: z.object({
    total: z.number().int(),
    breached: z.number().int(),
    breachPct: z.number().int(),
  }),
});

export const slaReportResponseSchema = z.object({
  report: z.array(slaReportMonthSchema),
  stages: z.array(z.string()),
  stageSummary: z.array(z.object({
    stage: z.string(),
    avgBreachPct: z.number().int(),
    totalBreached: z.number().int(),
    totalAll: z.number().int(),
  })),
});

export const interviewScorecardSchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  interviewId: z.number().int(),
  interviewerId: z.string(),
  interviewerMembershipId: z.number().int().nullable(),
  templateId: z.number().int().nullable(),
  ratings: z.record(z.string(), z.number()),
  recommendation: z.string(),
  notes: z.string().nullable(),
  isBlindMode: z.boolean(),
  submittedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const scorecardSummaryResponseSchema = z.object({
  interviewId: z.number().int(),
  totalScorecards: z.number().int(),
  submittedCount: z.number().int(),
  scorecards: z.array(interviewScorecardSchema),
  aggregatedRatings: z.record(z.string(), z.object({
    total: z.number(),
    count: z.number().int(),
    average: z.number(),
  })),
  recommendationCounts: z.record(z.string(), z.number().int()),
});

export const hiringFlowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const hiringRoundSchema = z.object({
  id: z.number().int(),
  flowId: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  roundType: z.string(),
  mode: z.string(),
  durationMinutes: z.number().int(),
  slaDays: z.number().int().nullable(),
  questionBankTag: z.string().nullable(),
  scorecardTemplateId: z.number().int().nullable(),
  interviewerRoleRestriction: z.string().nullable(),
  autoAdvanceThreshold: z.number().int().nullable(),
  orderIndex: z.number().int(),
  createdAt: wireDate(),
});

export const hiringFlowWithRoundsSchema = hiringFlowSchema.extend({
  rounds: z.array(hiringRoundSchema),
});

export const hiringFlowListResponseSchema = z.object({
  items: z.array(hiringFlowWithRoundsSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

export const scorecardTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  criteria: z.array(z.object({ name: z.string(), weight: z.number() })),
  isActive: z.boolean(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const bookingLinkSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  token: z.string(),
  durationMinutes: z.number().int(),
  interviewType: z.string(),
  availableSlots: z.array(z.unknown()),
  selectedSlot: nullableWireDate(),
  status: z.enum(["pending", "booked", "expired", "cancelled"]),
  expiresAt: wireDate(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const bookingCancelResponseSchema = z.object({
  success: z.literal(true),
});

export const bookingLinkWithRelationsSchema = bookingLinkSchema.extend({
  candidate: z.object({ id: z.number().int(), firstName: z.string(), lastName: z.string(), email: z.string() }).nullable(),
  jobPosting: z.object({ id: z.number().int(), title: z.string() }).nullable(),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export const offerDocumentTemplateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  htmlContent: z.string(),
  isDefault: z.boolean(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const generatePdfResponseSchema = z.object({
  base64: z.string(),
  mimeType: z.string(),
  fileName: z.string(),
});

export const offerLetterResponseSchema = z.object({
  documentId: z.number().int(),
  title: z.string(),
});

export const availabilityResponseSchema = z.object({
  date: z.string(),
  availability: z.array(z.object({
    interviewerId: z.string(),
    busyBlocks: z.array(z.object({
      start: z.string(),
      end: z.string(),
      title: z.string(),
    })),
  })),
});

export const scheduledReportSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  reportType: z.string().optional(),
  schedule: z.string().optional(),
  createdBy: z.string().optional(),
  name: z.string().optional(),
  createdAt: wireDate(),
  updatedAt: wireDate().optional(),
});

export const scorecardAnalyticsSchema = z.object({
  interviewerStats: z.array(z.object({
    interviewerId: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    totalScorecards: z.number().int(),
    avgRating: z.number(),
    recommendations: z.record(z.string(), z.number().int()),
    hireRate: z.number(),
    hiresAfterPositive: z.number().int(),
    positiveScorecards: z.number().int(),
  })),
  orgAvgRating: z.number(),
  totalScorecards: z.number().int(),
  scoreDistribution: z.array(z.object({ range: z.string(), count: z.number().int() })),
  period: z.object({ days: z.number().int(), since: z.string() }),
});

export const bookInterviewResponseSchema = z.object({
  success: z.literal(true),
  interviewId: z.number().int(),
});

export const selfScheduleResponseSchema = z.object({
  id: z.number().int(),
  token: z.string(),
  bookingUrl: z.string(),
  expiresAt: z.string(),
});

export const scheduleInterviewWithPanelSchema = interviewSchema.extend({
  panelInterviewerIds: z.array(z.string()),
});

export const interviewerPerformanceItemSchema = z.object({
  interviewerId: z.string(),
  interviewerName: z.string().nullable(),
  interviewerEmail: z.string(),
  totalAssigned: z.number().int(),
  submitted: z.number().int(),
  pending: z.number().int(),
  avgHoursToSubmit: z.number().nullable(),
  recommendations: z.record(z.string(), z.number().int()),
});

export const interviewerPerformanceSchema = z.object({
  stats: z.array(interviewerPerformanceItemSchema),
  period: z.object({ days: z.number().int(), since: z.string() }),
});

export const recruitmentAnalyticsSchema = z.object({
  funnel: z.array(z.object({
    stage: z.string(),
    count: z.number().int(),
    avgDaysInStage: z.number().nullable(),
  })),
  hireRate: z.number().int(),
  totalCandidates: z.number().int(),
  totalHired: z.number().int(),
});

export const recruitmentStatsSchema = z.object({
  totalJobs: z.number().int(),
  openJobs: z.number().int(),
  totalCandidates: z.number().int(),
  newCandidates: z.number().int(),
  upcomingInterviews: z.number().int(),
  hiredThisMonth: z.number().int(),
  funnel: z.record(z.string(), z.number().int()),
  sources: z.array(z.object({ source: z.string(), count: z.number().int() })),
  avgTimeToHireDays: z.number().int(),
});

export const generateReportResponseSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  entity: z.string(),
  fields: z.array(z.string()),
  total: z.number().int(),
});

export { successSchema };
