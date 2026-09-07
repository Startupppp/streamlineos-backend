import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const jobPostingSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  orgDepartmentId: z.string().nullable(),
  hiringFlowId: z.number().int().nullable(),
  location: z.string().nullable(),
  type: z.string(),
  experience: z.string().nullable(),
  salaryMin: z.string().nullable(),
  salaryMax: z.string().nullable(),
  description: z.string().nullable(),
  requirements: z.string().nullable(),
  benefits: z.string().nullable(),
  openings: z.number().int(),
  applicationDeadline: z.string().nullable(),
  closingDate: nullableWireDate(),
  postedBy: z.string().nullable(),
  postedByMembershipId: z.number().int().nullable(),
  externalPostingIds: z.record(z.string(), z.string()).nullable(),
  isInternal: z.boolean(),
  screeningQuestions: z.array(z.object({
    question: z.string(),
    type: z.string(),
    required: z.boolean(),
    knockout: z.boolean(),
  })).nullable(),
  status: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const jobPostingListResponseSchema = z.object({
  items: z.array(jobPostingSchema),
  total: z.number().int(),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const jobApplicationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int(),
  appliedAt: wireDate(),
  coverLetter: z.string().nullable(),
  notes: z.string().nullable(),
  screeningAnswers: z.record(z.string(), z.string()).nullable(),
  status: z.string().optional(),
  updatedAt: wireDate(),
});

export const jobPostingWithApplicationsSchema = jobPostingSchema.extend({
  applications: z.array(jobApplicationSchema),
});

export const jobRecruiterSchema = z.object({
  id: z.number().int(),
  userId: z.string(),
  assignedBy: z.string(),
  assignedAt: wireDate(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
});

export const jobShareResponseSchema = z.object({
  jobId: z.number().int(),
  title: z.string(),
  shareLinks: z.array(z.object({
    platform: z.string(),
    name: z.string(),
    url: z.string(),
    utmUrl: z.string(),
  })),
  directLink: z.string(),
  careersPageLink: z.string(),
});

export const jobPublishResponseSchema = z.object({
  results: z.array(z.object({
    platform: z.string(),
    status: z.string(),
  })),
  publishedCount: z.number().int(),
  externalIds: z.record(z.string(), z.string()),
});

export const internalJobSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  departmentId: z.string().nullable(),
  location: z.string().nullable(),
  type: z.string(),
  experience: z.string().nullable(),
  description: z.string().nullable(),
  requirements: z.string().nullable(),
  openings: z.number().int(),
  applicationDeadline: z.string().nullable(),
  createdAt: wireDate(),
  department: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export const candidateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  resumeUrl: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  portfolioUrl: z.string().nullable(),
  currentCompany: z.string().nullable(),
  currentRole: z.string().nullable(),
  experienceYears: z.string().nullable(),
  skills: z.array(z.string()).nullable(),
  source: z.string(),
  status: z.string(),
  notes: z.string().nullable(),
  rating: z.number().int().nullable(),
  referredBy: z.string().nullable(),
  externalId: z.string().nullable(),
  duplicateOfId: z.number().int().nullable(),
  aiScore: z.number().int().nullable(),
  aiScoreBreakdown: z.record(z.string(), z.number()).nullable(),
  aiScoreGeneratedAt: nullableWireDate(),
  bgvStatus: z.string().nullable(),
  bgvAgency: z.string().nullable(),
  bgvNotes: z.string().nullable(),
  bgvInitiatedAt: nullableWireDate(),
  bgvCompletedAt: nullableWireDate(),
  sourceUrl: z.string().nullable(),
  location: z.string().nullable(),
  gender: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const candidateListResponseSchema = z.object({
  items: z.array(candidateSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
  statusCounts: z.record(z.string(), z.number()),
});

export const candidateDuplicateGroupSchema = z.object({
  key: z.string().nullable(),
  candidates: z.array(candidateSchema),
});

export const candidateSlaTrackingSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  stage: z.string(),
  enteredAt: wireDate(),
  breachedAt: nullableWireDate(),
  status: z.string(),
  updatedAt: wireDate(),
});

export const candidateMoveStageResponseSchema = z.object({
  id: z.number().int(),
  stage: z.string(),
  changed: z.boolean(),
});

export const candidateBulkRejectResponseSchema = z.object({
  rejected: z.number().int(),
  alreadyRejected: z.number().int(),
  emailsSent: z.number().int(),
});

export const candidateBulkShortlistResponseSchema = z.object({
  shortlisted: z.number().int(),
  skipped: z.number().int(),
});

export const candidateImportResponseSchema = z.object({
  imported: z.number().int(),
});

export const pipelineStageSchema = z.object({
  stage: z.string(),
  total: z.number().int(),
  candidates: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    source: z.string().nullable(),
    rating: z.number().int().nullable(),
    jobTitle: z.string().nullable(),
    applicationId: z.number().int().nullable(),
    appliedAt: nullableWireDate(),
    slaStatus: z.string().nullable(),
    resumeUrl: z.string().nullable(),
    notes: z.string().nullable(),
  })),
});

export const pipelineResponseSchema = z.object({
  stages: z.array(pipelineStageSchema),
});

export const requisitionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  department: z.string().nullable(),
  location: z.string().nullable(),
  headcount: z.number().int(),
  hiringManagerId: z.string().nullable(),
  hiringManagerMembershipId: z.number().int().nullable(),
  priority: z.string(),
  type: z.string(),
  status: z.string(),
  requestedBy: z.string(),
  requestedByMembershipId: z.number().int().nullable(),
  approverId: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectionReason: z.string().nullable(),
  justification: z.string().nullable(),
  targetDate: z.string().nullable(),
  linkedJobId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const createJobFromRequisitionResponseSchema = z.object({
  jobId: z.number().int(),
  jobTitle: z.string(),
});

export const talentPoolSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const talentPoolMemberRowSchema = z.object({
  id: z.number().int(),
  poolId: z.number().int(),
  candidateId: z.number().int(),
  orgId: z.string(),
  notes: z.string().nullable(),
  addedBy: z.string().nullable(),
  addedAt: wireDate(),
});

export const talentPoolMemberItemSchema = z.object({
  membershipId: z.number().int(),
  notes: z.string().nullable(),
  addedAt: wireDate(),
  candidateId: z.number().int(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  currentCompany: z.string().nullable(),
  currentRole: z.string().nullable(),
  status: z.string(),
});

export const talentPoolMembersResponseSchema = cursorPageSchema(talentPoolMemberItemSchema);

export const pipelineAutomationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  trigger: z.string(),
  triggerConditions: z.record(z.string(), z.unknown()),
  action: z.string(),
  actionPayload: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const candidateOfferSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  offeredBy: z.string().nullable(),
  offerStatus: z.string(),
  offeredSalary: z.string().nullable(),
  offeredDesignation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  offerLetterUrl: z.string().nullable(),
  validUntil: z.string().nullable(),
  notes: z.string().nullable(),
  sentAt: nullableWireDate(),
  viewedAt: nullableWireDate(),
  respondedAt: nullableWireDate(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  approvalRemarks: z.string().nullable(),
  acceptanceToken: z.string().nullable(),
  acceptanceTokenExpiresAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const offerVersionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  offerId: z.number().int(),
  versionNumber: z.number().int(),
  offeredSalary: z.string().nullable(),
  offeredDesignation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  notes: z.string().nullable(),
  changeReason: z.string().nullable(),
  changedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const offerNegotiationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  offerId: z.number().int(),
  direction: z.string(),
  proposedSalary: z.string().nullable(),
  proposedJoiningDate: z.string().nullable(),
  message: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const enrollSequenceResponseSchema = z.object({
  enrolled: z.number().int(),
});

// ── Bulk import ───────────────────────────────────────────────────────────────
export const bulkImportResultSchema = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.string()),
});

// ── Automation ────────────────────────────────────────────────────────────────
export const pipelineAutomationWithCreatorSchema = pipelineAutomationSchema.extend({
  creator: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export const candidateMessageSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  direction: z.string(),
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  sentBy: z.string().nullable(),
  sentAt: wireDate(),
  readAt: nullableWireDate(),
  externalId: z.string().nullable(),
  senderName: z.string().nullable(),
  candidateFirstName: z.string().nullable(),
  candidateLastName: z.string().nullable(),
  candidateEmail: z.string().nullable(),
});

export const candidateMessageRawSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  direction: z.string(),
  channel: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  sentBy: z.string().nullable(),
  sentAt: wireDate(),
  readAt: nullableWireDate(),
  externalId: z.string().nullable(),
  createdAt: wireDate(),
});

export const messageThreadItemSchema = z.object({
  candidateId: z.number().int(),
  lastMessageAt: nullableWireDate(),
  messageCount: z.number().int(),
  unreadCount: z.number().int(),
  lastBody: z.string().nullable(),
  lastDirection: z.string().nullable(),
  candidateFirstName: z.string().nullable(),
  candidateLastName: z.string().nullable(),
  candidateEmail: z.string().nullable(),
});

export const emailSequenceStepSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  sequenceId: z.number().int(),
  stepOrder: z.number().int(),
  delayDays: z.number().int(),
  subject: z.string(),
  htmlBody: z.string(),
  createdAt: wireDate(),
});

const emailSequenceBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isActive: z.boolean(),
  triggerType: z.string(),
  targetAudience: z.record(z.string(), z.unknown()),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const emailSequenceWithStepsSchema = emailSequenceBaseSchema.extend({
  steps: z.array(emailSequenceStepSchema),
});

export const emailSequenceListItemSchema = emailSequenceBaseSchema.extend({
  steps: z.array(emailSequenceStepSchema),
  enrollments: z.array(z.object({ id: z.number().int(), status: z.string() })),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

export const emailSequenceDetailSchema = emailSequenceBaseSchema.extend({
  steps: z.array(emailSequenceStepSchema),
  enrollments: z.array(z.object({
    id: z.number().int(),
    status: z.string(),
    candidateId: z.number().int(),
    nextSendAt: nullableWireDate(),
  })),
  creator: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
});

// ── Candidate detail ──────────────────────────────────────────────────────────
export const candidateDetailSchema = candidateSchema.extend({
  applications: z.array(jobApplicationSchema.extend({
    jobPosting: jobPostingSchema.nullable(),
  })).optional(),
  interviews: z.array(z.object({
    id: z.number().int(),
    orgId: z.string(),
    candidateId: z.number().int(),
    jobPostingId: z.number().int().nullable(),
    interviewerId: z.string().nullable(),
    interviewerMembershipId: z.number().int().nullable(),
    type: z.string(),
    scheduledAt: wireDate(),
    duration: z.number().int(),
    location: z.string().nullable(),
    meetingLink: z.string().nullable(),
    result: z.string(),
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
    scorecards: z.array(z.object({
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
    })).optional(),
    interviewer: z.object({
      id: z.string(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
      email: z.string().nullable(),
      image: z.string().nullable(),
    }).nullable().optional(),
  })).optional(),
  slaTracking: z.array(candidateSlaTrackingSchema),
});

// ── Jobs - assignRecruiter union ──────────────────────────────────────────────
export const assignRecruiterResponseSchema = z.union([
  z.object({
    id: z.number().int(),
    orgId: z.string().nullable(),
    jobPostingId: z.number().int(),
    userId: z.string(),
    userMembershipId: z.number().int().nullable(),
    assignedBy: z.string(),
    assignedAt: wireDate(),
  }),
  z.object({ message: z.string() }),
]);

// ── Pipeline ──────────────────────────────────────────────────────────────────
export const diversityReportSchema = z.object({
  total: z.number().int(),
  genderBreakdown: z.array(z.object({ gender: z.string(), count: z.number().int() })),
  locationBreakdown: z.array(z.object({ location: z.string(), count: z.number().int() })),
  sourceBreakdown: z.array(z.object({ source: z.string(), count: z.number().int() })),
  stageBreakdown: z.array(z.object({ stage: z.string(), count: z.number().int() })),
});

export const bgvComplianceItemSchema = z.object({
  jobPostingId: z.number().int().nullable(),
  jobTitle: z.string(),
  total: z.number().int(),
  cleared: z.number().int(),
  failed: z.number().int(),
  pending: z.number().int(),
  initiated: z.number().int(),
  notInitiated: z.number().int(),
  clearedPct: z.number().int(),
});

// ── Recruiters ────────────────────────────────────────────────────────────────
export const recruiterPortalSchema = z.object({
  id: z.number().int(),
  platform: z.string(),
  isActive: z.boolean(),
  lastSyncedAt: nullableWireDate(),
  lastSyncCount: z.number().int().nullable(),
  createdAt: wireDate(),
});

export const syncPortalResponseSchema = z.object({
  platform: z.string(),
  status: z.string(),
  lastSyncedAt: z.string(),
  message: z.string(),
});

export const recruiterDirectoryItemSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  assignedJobsCount: z.number().int(),
  activitySummary: z.record(z.string(), z.number().int()),
});

export const recruiterActivityItemSchema = z.object({
  id: z.number().int(),
  recruiterId: z.string(),
  action: z.string(),
  candidateId: z.number().int().nullable(),
  jobPostingId: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  recruiterName: z.string().nullable(),
  candidateFirstName: z.string().nullable(),
  candidateLastName: z.string().nullable(),
  jobTitle: z.string().nullable(),
});

export const recruiterActivityLogRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  recruiterId: z.string(),
  action: z.string(),
  candidateId: z.number().int().nullable(),
  jobPostingId: z.number().int().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
});

// ── Sourcing ──────────────────────────────────────────────────────────────────
export const candidateReferralRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  referredBy: z.string(),
  referredByMembershipId: z.number().int().nullable(),
  jobPostingId: z.number().int().nullable(),
  relationship: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.string(),
  bonusEligible: z.boolean(),
  bonusAmount: z.string().nullable(),
  bonusPaidAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const candidateReferralWithRelationsSchema = candidateReferralRowSchema.extend({
  candidate: z.object({ id: z.number().int(), firstName: z.string(), lastName: z.string(), email: z.string() }).nullable(),
  referrer: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }).nullable(),
  jobPosting: z.object({ id: z.number().int(), title: z.string() }).nullable(),
});

export const vendorListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  website: z.string().nullable(),
  feePercent: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  submissionCount: z.number().int(),
  placements: z.number().int(),
  revenueTotal: z.string(),
});

export const vendorRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  website: z.string().nullable(),
  feePercent: z.string().nullable(),
  status: z.string(),
  contractType: z.string(),
  slaDays: z.number().int().nullable(),
  replacementGuaranteeDays: z.number().int().nullable(),
  portalToken: z.string().nullable(),
  portalTokenExpiresAt: nullableWireDate(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const vendorPortalLinkSchema = z.object({
  portalToken: z.string().nullable(),
  portalTokenExpiresAt: nullableWireDate(),
});

export const vendorSubmissionItemSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  submittedAt: wireDate(),
  placementStatus: z.string(),
  invoiceStatus: z.string(),
  invoiceAmount: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  paidAt: z.string().nullable(),
  billRate: z.string().nullable(),
  payRate: z.string().nullable(),
  contractStartDate: z.string().nullable(),
  contractEndDate: z.string().nullable(),
  candidateFirstName: z.string().nullable(),
  candidateLastName: z.string().nullable(),
  candidateEmail: z.string().nullable(),
  jobTitle: z.string().nullable(),
  margin: z.string().nullable(),
});

export const vendorSubmissionRawSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  vendorId: z.number().int(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  submittedAt: wireDate(),
  placementStatus: z.string(),
  invoiceStatus: z.string(),
  invoiceAmount: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  paidAt: z.string().nullable(),
  billRate: z.string().nullable(),
  payRate: z.string().nullable(),
  contractStartDate: z.string().nullable(),
  contractEndDate: z.string().nullable(),
  createdAt: wireDate(),
});

export const headcountRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  orgDepartmentId: z.string().nullable(),
  requestedBy: z.string(),
  requestedByMembershipId: z.number().int().nullable(),
  requestedRole: z.string(),
  level: z.string().nullable(),
  justification: z.string().nullable(),
  targetDate: z.string().nullable(),
  status: z.string(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectedReason: z.string().nullable(),
  linkedJobPostingId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const headcountListItemSchema = headcountRowSchema.extend({
  departmentName: z.string().nullable(),
  requesterName: z.string().nullable(),
  requesterEmail: z.string().nullable(),
});

export const headcountListPageSchema = cursorPageSchema(headcountListItemSchema);

const externalReferralBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  referrerId: z.number().int(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  status: z.string(),
  rewardAmount: z.string().nullable(),
  rewardPaidAt: nullableWireDate(),
  ipAddress: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const externalReferralRawSchema = externalReferralBaseSchema;

export const externalReferralWithRelationsSchema = externalReferralBaseSchema.extend({
  candidate: z.object({ id: z.number().int(), firstName: z.string(), lastName: z.string(), email: z.string() }).nullable(),
  referrer: z.object({ id: z.number().int(), name: z.string(), email: z.string() }).nullable(),
  jobPosting: z.object({ id: z.number().int(), title: z.string() }).nullable(),
});

export const externalReferrerListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  referralCount: z.number().int(),
});

export const externalReferrerRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  referralToken: z.string(),
  status: z.string(),
  emailVerifiedAt: nullableWireDate(),
  createdAt: wireDate(),
});

// ── Job boards ────────────────────────────────────────────────────────────────
export const jobBoardPostingSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  jobPostingId: z.number().int(),
  platform: z.string(),
  externalPostUrl: z.string().nullable(),
  status: z.string(),
  postedBy: z.string().nullable(),
  postedAt: nullableWireDate(),
  expiryDate: nullableWireDate(),
  spend: z.string().nullable(),
  applicantCount: z.number().int(),
  qualifiedCount: z.number().int(),
  hiredCount: z.number().int(),
  notes: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

// ── Offers list ───────────────────────────────────────────────────────────────
export const offerListItemSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  candidateFirstName: z.string(),
  candidateLastName: z.string(),
  candidateEmail: z.string(),
  jobPostingId: z.number().int().nullable(),
  jobTitle: z.string().nullable(),
  offerStatus: z.string(),
  offeredSalary: z.string().nullable(),
  offeredDesignation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  sentAt: nullableWireDate(),
  respondedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const offerListResponseSchema = z.object({
  items: z.array(offerListItemSchema),
  total: z.number().int(),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

// ── Candidate records - AI ────────────────────────────────────────────────────
export const aiScoreResultSchema = z.object({
  overall: z.number(),
  breakdown: z.object({
    technicalSkills: z.number(),
    experience: z.number(),
    communication: z.number(),
    cultureFit: z.number(),
    leadership: z.number(),
  }),
  summary: z.string(),
});

export const compositeScoreResultSchema = z.object({
  verdict: z.enum(["STRONG_HIRE", "HIRE", "ON_FENCE", "NO_HIRE"]),
  overall: z.number(),
  reasoning: z.string(),
  strengthsAcrossRounds: z.array(z.string()),
  concernsAcrossRounds: z.array(z.string()),
  roundSummaries: z.array(z.object({
    interviewType: z.string(),
    scheduledAt: z.string(),
    recommendation: z.string(),
    overallRating: z.number().nullable(),
    keyNotes: z.string(),
  })),
});

export const resumeParseResponseSchema = z.object({
  parsed: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    currentCompany: z.string().nullable(),
    currentRole: z.string().nullable(),
    experienceYears: z.number().nullable(),
    skills: z.array(z.string()),
    location: z.string().nullable(),
    education: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    portfolioUrl: z.string().nullable(),
  }).nullable(),
  suggestions: z.object({
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    currentCompany: z.string().nullable(),
    currentRole: z.string().nullable(),
    experienceYears: z.number().nullable(),
    skills: z.array(z.string()).nullable(),
    location: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    portfolioUrl: z.string().nullable(),
  }),
});

// ── Candidate records - docs ──────────────────────────────────────────────────
export const candidateDocumentSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  orgId: z.string(),
  templateId: z.number().int().nullable(),
  title: z.string(),
  htmlContent: z.string(),
  status: z.string(),
  externalDocId: z.string().nullable(),
  sentAt: nullableWireDate(),
  viewedAt: nullableWireDate(),
  signedAt: nullableWireDate(),
  declinedAt: nullableWireDate(),
  acceptanceDeadline: nullableWireDate(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const rolloutDocumentItemSchema = z.object({
  id: z.number().int(),
  templateId: z.number().int().nullable(),
  templateTitle: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  sentAt: nullableWireDate(),
  viewedAt: nullableWireDate(),
  signedAt: nullableWireDate(),
  declinedAt: nullableWireDate(),
  createdAt: wireDate(),
  createdBy: z.string(),
});

export const generateRolloutResponseSchema = z.object({
  documents: z.array(candidateDocumentSchema),
  count: z.number().int(),
});

// ── Candidate records - calibration ──────────────────────────────────────────
export const calibrationSessionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  scheduledAt: nullableWireDate(),
  status: z.string(),
  notes: z.string().nullable(),
  decision: z.string().nullable(),
  createdBy: z.string(),
  createdByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  participantIds: z.array(z.string()),
});

// ── Candidate records - referrals & checks ────────────────────────────────────
export const candidateReferralCandidateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  referredBy: z.string(),
  referredByMembershipId: z.number().int().nullable(),
  jobPostingId: z.number().int().nullable(),
  relationship: z.string().nullable(),
  notes: z.string().nullable(),
  status: z.string(),
  bonusEligible: z.boolean(),
  bonusAmount: z.string().nullable(),
  bonusPaidAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const referenceCheckSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  orgId: z.string(),
  referenceName: z.string(),
  referenceDesignation: z.string().nullable(),
  referenceCompany: z.string().nullable(),
  referenceEmail: z.string().nullable(),
  referencePhone: z.string().nullable(),
  relationship: z.string().nullable(),
  status: z.string(),
  outcome: z.string().nullable(),
  notes: z.string().nullable(),
  contactedAt: nullableWireDate(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

// ── Candidate records - vault ─────────────────────────────────────────────────
export const vaultDocumentSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  orgId: z.string(),
  filename: z.string(),
  s3Key: z.string(),
  fileUrl: z.string(),
  fileType: z.string(),
  fileSize: z.number().int(),
  documentType: z.string().nullable(),
  avResult: z.string(),
  expiresAt: z.string().nullable(),
  uploadedBy: z.string(),
  createdAt: wireDate(),
});

export const vaultAccessLogItemSchema = z.object({
  id: z.number().int(),
  action: z.string(),
  accessedAt: wireDate(),
  fileName: z.string(),
  documentType: z.string().nullable(),
  accessorName: z.string().nullable(),
  accessorFirstName: z.string().nullable(),
  accessorLastName: z.string().nullable(),
  accessorDisplayName: z.string(),
});

export const candidateActivityEventSchema = z.object({
  type: z.enum(["AUDIT", "INTERVIEW", "MESSAGE", "DOCUMENT"]),
  id: z.string(),
  label: z.string(),
  detail: z.record(z.string(), z.unknown()),
  actor: z.string().nullable(),
  at: wireDate(),
});

export { successSchema, cursorPageSchema };
