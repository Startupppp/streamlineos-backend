import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../common/openapi/response-envelopes";

export { successSchema as contactSubmitSchema };

export const waitlistJoinSchema = z.object({
  ok: z.boolean(),
  reference: z.string(),
  alreadyJoined: z.boolean(),
});

/**
 * The candidate-facing view of an application.
 *
 * Six coarse statuses, a first name, the job, and the two links a candidate can
 * act on. No email, no notes, no scores — the token that reaches this endpoint
 * travels in a URL, and a URL ends up in mail archives, browser history and
 * referrer headers.
 */
export const applicationStatusSchema = z.object({
  status: z.enum(["received", "in_review", "interview", "offer", "hired", "rejected"]),
  statusText: z.string(),
  appliedAt: nullableWireDate(),
  updatedAt: wireDate(),
  jobTitle: z.string(),
  jobLocation: z.string().nullable(),
  jobType: z.string().nullable(),
  organisationName: z.string(),
  candidateFirstName: z.string(),
  bookingUrl: z.string().nullable(),
  offerUrl: z.string().nullable(),
});

const orgInfoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  logo: z.string().nullable(),
  industry: z.string().nullable(),
});

const jobSummarySchema = z.object({
  id: z.number().int(),
  title: z.string(),
  location: z.string().nullable(),
  type: z.string().nullable(),
  experience: z.string().nullable(),
  salaryMin: z.string().nullable(),
  salaryMax: z.string().nullable(),
  openings: z.number().int(),
  applicationDeadline: z.string().nullable(),
  createdAt: wireDate(),
});

export const jobListSchema = z.object({
  org: orgInfoSchema,
  jobs: z.array(jobSummarySchema),
});

/**
 * The questions the careers form renders. They are part of the job's public
 * contract: the apply endpoint refuses a missing required answer and knocks out
 * a disqualifying one, so a form that cannot see them cannot be filled in
 * correctly. `knockoutAnswer` is deliberately absent — publishing the passing
 * answer would tell every applicant what to say.
 */
const publicScreeningQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  type: z.enum(["TEXT", "YES_NO", "SINGLE_SELECT", "NUMBER"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const jobDetailSchema = z.object({
  org: orgInfoSchema,
  job: jobSummarySchema.extend({
    description: z.string().nullable(),
    requirements: z.string().nullable(),
    benefits: z.string().nullable(),
    closingDate: z.string().nullable(),
    screeningQuestions: z.array(publicScreeningQuestionSchema).nullable(),
  }),
});

export const jobApplicationSchema = z.object({
  trackingToken: z.string(),
  duplicate: z.boolean(),
  resumeStored: z.boolean(),
  resumeReason: z.string().nullable(),
});

export const offerDetailSchema = z.object({
  id: z.number().int(),
  offerStatus: z.string(),
  currency: z.string(),
  offeredSalary: z.string().nullable(),
  offeredDesignation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  notes: z.string().nullable(),
  negotiations: z.array(z.record(z.string(), z.unknown())),
});

export const offerRespondSchema = z.object({
  success: z.boolean(),
  status: z.string(),
});

export const bookingLinkSchema = z.object({
  url: z.string().nullable(),
  interviewId: z.number().int(),
});

export const externalReferrerRegisterSchema = z.object({
  referralToken: z.string(),
  name: z.string().nullable(),
  orgName: z.string(),
});

export const referrerPortalSchema = z.object({
  referrerName: z.string().nullable(),
  orgName: z.string(),
  currency: z.string(),
  openJobs: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      location: z.string().nullable(),
    }),
  ),
  referrals: z.array(
    z.object({
      id: z.number().int(),
      candidateName: z.string(),
      jobTitle: z.string().nullable(),
      status: z.string(),
      rewardAmount: z.string().nullable(),
      createdAt: wireDate(),
    }),
  ),
});

export const externalReferralSubmitSchema = z.discriminatedUnion("alreadyReferred", [
  z.object({ alreadyReferred: z.literal(true) }),
  z.object({
    alreadyReferred: z.literal(false),
    referral: z.record(z.string(), z.unknown()),
  }),
]);

export const vendorPortalSchema = z.object({
  vendorName: z.string().nullable(),
  submissions: z.array(
    z.object({
      id: z.number().int(),
      candidateName: z.string(),
      jobTitle: z.string().nullable(),
      placementStatus: z.string(),
      submittedAt: wireDate(),
    }),
  ),
});

export const intakeSubmitSchema = z.object({
  id: z.number().int(),
  message: z.string(),
});

const publicFormFieldSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
});

export const publicFormSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  fields: z.array(publicFormFieldSchema),
  branding: z.record(z.string(), z.unknown()).nullable(),
});

export const publicFormSubmitSchema = z.object({
  id: z.number().int(),
  message: z.string(),
});

export const leadFormSchema = z.object({
  form: z.record(z.string(), z.unknown()),
});

export const leadFormSubmitSchema = z.object({
  id: z.number().int().optional(),
  partyId: z.string().optional(),
  leadId: z.number().int().optional(),
  message: z.string().optional(),
});

export const publicSurveySchema = z.object({
  survey: z.record(z.string(), z.unknown()),
});

export { successSchema as surveySumbitSchema };

const roadmapItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  category: z.string().nullable(),
  targetQuarter: z.string().nullable(),
  votes: z.number().int(),
});

const feedbackPostSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  votes: z.number().int(),
  createdAt: wireDate(),
});

const changelogEntrySchema = z.object({
  id: z.number().int(),
  title: z.string(),
  content: z.string().nullable(),
  version: z.string().nullable(),
  type: z.string().nullable(),
  publishedAt: nullableWireDate(),
});

export const roadmapSchema = z.object({
  orgName: z.string().nullable(),
  roadmap: z.object({
    planned: z.array(roadmapItemSchema),
    in_progress: z.array(roadmapItemSchema),
    completed: z.array(roadmapItemSchema),
  }),
  feedback: z.array(feedbackPostSchema),
  changelog: z.array(changelogEntrySchema),
});

export const roadmapVoteSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  votes: z.number().int(),
  voted: z.boolean(),
});

export const roadmapFeedbackSchema = z.object({
  id: z.number().int(),
  message: z.string(),
});

export const orgNameSchema = z.object({ name: z.string() });

const kbArticleSummarySchema = z.object({
  id: z.number().int(),
  title: z.string(),
  slug: z.string(),
  excerpt: z.string().nullable(),
  publishedAt: nullableWireDate(),
});

const kbCategorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
});

export const kbListSchema = z.object({
  categories: z.array(kbCategorySchema),
  articles: z.array(kbArticleSummarySchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const kbArticleSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  slug: z.string(),
  content: z.string().nullable(),
  excerpt: z.string().nullable(),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  categoryName: z.string().nullable(),
  tags: z.array(z.string()),
  views: z.number().int(),
  publishedAt: nullableWireDate(),
});

export const kbFeedbackSchema = z.object({
  success: z.boolean(),
  recorded: z.boolean(),
});

/**
 * `GET /public/pricing`. Money is minor units, as everywhere else in billing,
 * and `seatLimit` is null for unlimited — zero would read as "no seats".
 *
 * `isRequestedCurrency` is on the contract rather than implied because a
 * prospect shown a number without being told which currency it is in finds out
 * at checkout, which is the worst possible moment.
 */
export const publicPricingSchema = z.object({
  currency: z.string(),
  isRequestedCurrency: z.boolean(),
  annualDiscountPct: z.number().int(),
  trialDays: z.number().int(),
  plans: z.array(z.object({
    plan: z.enum(["STARTER", "PROFESSIONAL", "ENTERPRISE"]),
    monthlyMinor: z.number().int(),
    annualMinor: z.number().int(),
    seatLimit: z.number().int().nullable(),
  })),
});

/**
 * `GET /public/data-residency`. `likely` is present only when the caller named a
 * country, and `isMapped` says whether that country was actually mapped or fell
 * to the default — a default presented as a determination is how somebody
 * discovers after migrating that it was a guess.
 */
export const dataResidencySchema = z.object({
  options: z.array(z.object({
    region: z.enum(["eu", "us", "india"]),
    description: z.string(),
    examples: z.array(z.string()),
  })),
  likely: z.object({
    region: z.enum(["eu", "us", "india"]),
    description: z.string(),
    isMapped: z.boolean(),
  }).optional(),
});

/** The operator's view of the waitlist. Never the token digest. */
export const waitlistEntryListSchema = z.array(z.object({
  id: z.number().int(),
  reference: z.string(),
  name: z.string(),
  email: z.string(),
  organization: z.string().nullable(),
  role: z.string().nullable(),
  teamSize: z.string().nullable(),
  status: z.string(),
  admittedAt: nullableWireDate(),
  claimedAt: nullableWireDate(),
  createdAt: wireDate(),
}));

/**
 * The raw claim token is handed to the operator once, inside `claimPath` — it is
 * stored only as a digest and is never readable again. When an admission email
 * template exists this stops being returned at all.
 */
export const waitlistAdmitSchema = z.object({
  reference: z.string(),
  email: z.string(),
  expiresAt: wireDate(),
  claimPath: z.string(),
});

/** A claim answers with the entry it spent, and nothing about the tenant it made. */
export const waitlistClaimSchema = z.object({
  reference: z.string(),
  email: z.string(),
});
