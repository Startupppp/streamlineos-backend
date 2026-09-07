import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

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
