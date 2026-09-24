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
  /**
   * What the candidate agreed to and when it runs out.
   *
   * Declared on the wire so a recruiter looking at the record can see the
   * purpose and the expiry without opening the database. `consentTextHash` is
   * deliberately NOT exposed: it is an integrity artifact for proving what
   * wording was shown, it means nothing to a reader, and a hash on screen
   * invites somebody to treat it as an identifier.
   *
   * All four are null on every application created before migration 1187, and
   * the UI says so rather than rendering a blank.
   */
  consentAt: nullableWireDate(),
  consentPurpose: z.string().nullable(),
  consentVersion: z.string().nullable(),
  retainUntil: nullableWireDate(),
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

/**
 * One entry per board asked for, and the vocabulary a publish request can
 * honestly answer with at the moment it returns.
 *
 * There is no `PUBLISHED` member and no `POSTED` member, because at the instant
 * this response is written nothing has been sent: `publish` queues, and
 * `JobBoardOutboxConsumer` is what talks to the vendor. `QUEUED` is therefore
 * the true positive answer, and it carries the `postingId` so the caller can
 * follow the row to `LIVE` or `FAILED`.
 *
 * `BLOCKED` carries a machine-readable `code` so the UI can say WHICH problem
 * this is — "not connected" and "we cannot post to this board yet" need
 * different actions from the recruiter.
 */
export const jobBoardOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    platform: z.string(),
    status: z.literal("BLOCKED"),
    code: z.enum(["no-integration", "inactive", "needs-keys", "not-implemented"]),
    message: z.string(),
  }),
  z.object({
    platform: z.string(),
    status: z.literal("QUEUED"),
    postingId: z.number().int(),
  }),
  z.object({
    platform: z.string(),
    status: z.literal("FAILED"),
    message: z.string(),
    httpStatus: z.number().int().nullable(),
  }),
]);

export const jobPublishResponseSchema = z.object({
  results: z.array(jobBoardOutcomeSchema),
  queuedCount: z.number().int(),
  blockedCount: z.number().int(),
  failedCount: z.number().int(),
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
  /** The id the board returned, or null when no board ever confirmed one. */
  externalPostingId: z.string().nullable(),
  status: z.string(),
  /** Why the row is in that status — a blocked code, or the vendor's refusal. */
  statusDetail: z.string().nullable(),
  lastAttemptAt: nullableWireDate(),
  lastSyncedAt: nullableWireDate(),
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
