import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

// ── Alumni ────────────────────────────────────────────────────────────────────

export const alumniProfileSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  currentCompany: z.string().nullable(),
  currentRole: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  email: z.string().nullable(),
  leftDate: z.string().nullable(),
  isOptedIn: z.boolean(),
  rehireEligibility: z.boolean(),
  createdAt: wireDate(),
  user: z.object({ name: z.string().nullable(), email: z.string().nullable(), image: z.string().nullable() }).nullable(),
});

export const alumniProfileListSchema = z.array(alumniProfileSchema);

// ── Exit / Resignation ────────────────────────────────────────────────────────

const resignationUserSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  designation: z.string().nullable(),
  joiningDate: z.string().nullable(),
}).nullable();

const exitChecklistItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  resignationId: z.number().int(),
  item: z.string(),
  assignedTo: z.string().nullable(),
  assignedToMembershipId: z.number().int().nullable(),
  status: z.string(),
  completedAt: nullableWireDate(),
  notes: z.string().nullable(),
});

export const resignationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  reason: z.string().nullable(),
  reasonCategory: z.string().nullable(),
  lastWorkingDate: z.string().nullable(),
  noticePeriodDays: z.number().int(),
  status: z.string(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  hrReviewedBy: z.string().nullable(),
  hrReviewedAt: nullableWireDate(),
  hrRemarks: z.string().nullable(),
  finalReviewedBy: z.string().nullable(),
  finalReviewedAt: nullableWireDate(),
  finalRemarks: z.string().nullable(),
  willingForExitInterview: z.boolean(),
  companyFeedback: z.string().nullable(),
  exitInterviewNotes: z.string().nullable(),
  exitInterviewDate: nullableWireDate(),
  exitInterviewConductedBy: z.string().nullable(),
  feedback: z.array(z.object({ question: z.string(), answer: z.string() })).nullable(),
  userMembershipId: z.number().int().nullable(),
  rowVersion: z.number().int(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  hasResignationLetter: z.boolean(),
  user: resignationUserSchema,
  checklists: z.array(exitChecklistItemSchema),
  hrReviewer: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  finalReviewer: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export const resignationListSchema = z.object({
  data: z.array(resignationSchema),
  pagination: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
});

const resignationProgressStepSchema = z.object({
  label: z.string(),
  status: z.string(),
  actor: z.string().nullable(),
  timestamp: nullableWireDate(),
  remarks: z.string().nullable(),
});

export const resignationProgressSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  isRejected: z.boolean(),
  isWithdrawn: z.boolean(),
  steps: z.array(resignationProgressStepSchema),
  lastWorkingDate: z.string().nullable(),
  reasonCategory: z.string().nullable(),
});

export const exitLetterSchema = z.object({ html: z.string() });
export const uploadedFileUrlSchema = z.object({ url: z.string(), expiresIn: z.number().int() });
export const signedDocFileSchema = z.object({ url: z.string(), fileName: z.string(), expiresIn: z.number().int() });
export const experienceLetterCreateResponseSchema = z.object({
  documentId: z.number().int(),
  title: z.string(),
});

export const exitAnalyticsSchema = z.object({
  totalEmployees: z.number().int(),
  totalResignations: z.number().int(),
  attritionRate: z.number().int(),
  averageTenureMonths: z.number(),
  reasonBreakdown: z.array(z.object({ category: z.string(), count: z.number().int() })),
  monthlyTrend: z.array(z.object({ month: z.string(), count: z.number().int() })),
  statusCounts: z.record(z.string(), z.number().int()),
});

// ── Termination ────────────────────────────────────────────────────────────────

const terminationEmployeeSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  designation: z.string().nullable(),
  employeeId: z.string().nullable(),
}).nullable();

export const terminationItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  status: z.string(),
  reasons: z.array(z.string()),
  detailedExplanation: z.string(),
  effectiveDate: z.string(),
  severanceAmount: z.string().nullable(),
  noticePeriodWaived: z.boolean(),
  internalNotes: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  finalRemarks: z.string().nullable(),
  finalReviewedBy: z.string().nullable(),
  finalReviewedAt: nullableWireDate(),
  emailSentAt: nullableWireDate(),
  emailStatus: z.string().nullable(),
  initiatedBy: z.string().nullable(),
  employee: terminationEmployeeSchema,
});

export const terminationListSchema = z.object({
  data: z.array(terminationItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  statusCounts: z.record(z.string(), z.number().int()),
});

export const terminationLetterSchema = z.object({ html: z.string() });

export const terminationRowSchema = terminationItemSchema.omit({ employee: true }).extend({
  userMembershipId: z.number().int().nullable(),
  terminationLetterUrl: z.string().nullable(),
  supportingDocUrls: z.array(z.string()),
  rowVersion: z.number().int(),
});

export const terminationDetailSchema = terminationItemSchema.omit({ employee: true }).extend({
  userMembershipId: z.number().int().nullable(),
  terminationLetterUrl: z.string().nullable(),
  supportingDocUrls: z.array(z.string()),
  rowVersion: z.number().int(),
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    image: z.string().nullable(),
    designation: z.string().nullable(),
    joiningDate: z.string().nullable(),
  }).nullable(),
  initiator: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  finalReviewer: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

// ── Probation ──────────────────────────────────────────────────────────────────

export const probationReviewItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  employmentId: z.number().int(),
  personId: z.number().int(),
  probationEndDate: z.string(),
  status: z.string(),
  extensionCount: z.number().int(),
  extendedUntil: z.string().nullable(),
  confirmedAt: nullableWireDate(),
  createdAt: wireDate(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  workEmail: z.string().nullable(),
});

export const probationListSchema = z.object({
  data: z.array(probationReviewItemSchema),
  pageInfo: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const probationStartReviewSchema = z.object({
  reviewId: z.number().int(),
  userId: z.string(),
  created: z.boolean(),
});

export const hrProbationReviewSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  employmentId: z.number().int(),
  personId: z.number().int(),
  probationEndDate: z.string(),
  status: z.string(),
  extensionCount: z.number().int(),
  extendedUntil: z.string().nullable(),
  reviewTemplateId: z.number().int().nullable(),
  reviewNotes: z.record(z.string(), z.unknown()).nullable(),
  confirmedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

// ── Onboarding Docs ────────────────────────────────────────────────────────────

export const onboardingDocListItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  employeeName: z.string().nullable(),
  documentTypeId: z.number().int(),
  documentTypeName: z.string(),
  isMandatory: z.boolean(),
  hasFile: z.boolean(),
  fileName: z.string(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string().nullable(),
  version: z.number().int(),
  status: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAt: nullableWireDate(),
  remarks: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  reviewerName: z.string().nullable(),
});

export const onboardingDocumentListSchema = cursorPageSchema(onboardingDocListItemSchema);

export const onboardingDocumentRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  documentTypeId: z.number().int(),
  fileUrl: z.string(),
  fileName: z.string(),
  fileSize: z.number().int().nullable(),
  mimeType: z.string().nullable(),
  version: z.number().int(),
  status: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAt: nullableWireDate(),
  remarks: z.string().nullable(),
  rowVersion: z.number().int(),
  updatedByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

const onboardingDocsSummaryItemSchema = z.object({
  userId: z.string(),
  userName: z.string().nullable(),
  userImage: z.string().nullable(),
  designation: z.string().nullable(),
  employeeId: z.string().nullable(),
  onboardingDocStatus: z.enum(["PENDING", "IN_PROGRESS", "APPROVED"]),
  totalRequired: z.number().int(),
  totalSubmitted: z.number().int(),
  totalApproved: z.number().int(),
  totalRejected: z.number().int(),
});

export const onboardingDocsSummarySchema = z.object({
  data: z.array(onboardingDocsSummaryItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    total: z.number().int(),
  }),
});

// ── Dashboard ──────────────────────────────────────────────────────────────────

export const hrDashboardMetricsSchema = z.object({
  totalEmployees: z.number().int(),
  activeEmployees: z.number().int(),
  onLeaveToday: z.number().int(),
  pendingLeaveRequests: z.number().int(),
  openPositions: z.number().int(),
  monthlyHires: z.number().int(),
  upcomingBirthdays: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    image: z.string().nullable(),
    dateOfBirth: z.string().nullable(),
    daysUntil: z.number().int(),
  })),
});

export const hrDashboardDiversitySchema = z.object({
  genderBreakdown: z.array(z.object({ gender: z.string(), count: z.number().int() })),
  ageDistribution: z.array(z.object({ range: z.string(), count: z.number().int() })),
});

export const hrDashboardOnboardingStatusSchema = z.object({
  inProgress: z.number().int(),
  completed: z.number().int(),
  total: z.number().int(),
  completionPct: z.number().int(),
  newHires: z.array(z.object({
    userId: z.string(),
    name: z.string(),
    completedTasks: z.number().int(),
    totalTasks: z.number().int(),
    pct: z.number().int(),
  })),
});

export const headcountTrendsSchema = z.object({
  trends: z.array(z.object({ month: z.string(), count: z.number().int() })),
});

export const timeToFillSchema = z.object({
  avgDaysOverall: z.number().nullable(),
  byDepartment: z.array(z.object({ department: z.string(), avgDays: z.number() })),
});

// ── HR Analytics ───────────────────────────────────────────────────────────────

export const hrAnalyticsOverviewSchema = z.object({
  headcount: z.object({
    total: z.number().int(),
    active: z.number().int(),
    newThisMonth: z.number().int(),
  }),
  departments: z.array(z.object({ name: z.string(), count: z.number().int() })),
  gender: z.array(z.object({ gender: z.string(), count: z.number().int() })),
  roles: z.array(z.object({ role: z.string(), count: z.number().int() })),
  attendance: z.object({ totalLogsThisMonth: z.number().int() }),
  leaves: z.object({
    byStatus: z.record(z.string(), z.number().int()),
    byMonth: z.array(z.object({ month: z.string(), count: z.number().int() })),
  }),
  payroll: z.object({ totalCostYTD: z.string() }),
  expenses: z.object({ approvedYTD: z.string() }),
  joiningExitsTrend: z.array(z.object({
    month: z.string(),
    joins: z.number().int(),
    exits: z.number().int(),
  })),
});

export const hrAttendanceAnalyticsSchema = z.object({
  year: z.number().int(),
  month: z.number().int(),
  totalAttendanceLogs: z.number().int(),
  byDepartment: z.array(z.object({ department: z.string(), count: z.number().int() })),
  daily: z.array(z.object({ date: z.string(), count: z.number().int() })),
});

export const hrAttritionSchema = z.object({
  totalEmployees: z.number().int(),
  resignedThisYear: z.number().int(),
  attritionRatePercent: z.string(),
  byMonth: z.array(z.object({ month: z.string(), count: z.number().int() })),
});

export { successSchema };
