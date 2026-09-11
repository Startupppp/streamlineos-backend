import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { jobApplicationSchema, jobPostingSchema } from "./recruitment-jobs-response.schemas";

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
  data: z.array(candidateSchema),
  pagination: z.object({
    limit: z.number().int(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
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

export const bulkImportResultSchema = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.string()),
});

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
