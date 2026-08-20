import { z } from "zod";

export const applySchema = z.object({
  name: z.string().min(1).max(200).trim(),
  email: z.string().email().max(200).toLowerCase(),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().url().max(500).optional(),
  coverLetter: z.string().max(5000).optional(),
  resumeUrl: z.string().url().max(500).optional(),
});

export const offerRespondSchema = z.object({
  action: z.enum(["accept", "decline", "counter"]),
  declineReason: z.string().max(1000).optional(),
  counterSalary: z.number().positive().optional(),
  counterMessage: z.string().max(2000).optional(),
});

export const roadmapQuerySchema = z.object({
  org: z.string().trim().min(1),
});

export const roadmapVoteSchema = z.object({
  type: z.enum(["roadmap", "feedback"]),
  id: z.number().int().positive(),
  voterKey: z.string().trim().min(8).max(100),
});

export const roadmapFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().optional(),
});

export const kbListQuerySchema = z.object({
  org: z.string().min(1),
  categoryId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

export const orgQuerySchema = z.object({
  org: z.string().min(1),
});

export const kbFeedbackSchema = z.object({
  helpful: z.boolean(),
  comment: z.string().max(1000).optional(),
  visitorId: z.string().max(100).optional(),
});

export const npsSubmitSchema = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().max(2000).optional(),
  name: z.string().max(200).optional(),
  email: z
    .union([z.string().email("Please enter a valid email address").max(320), z.literal("")])
    .optional(),
});

export const leadFormBodySchema = z.record(z.string(), z.unknown());

export const intakeSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  submitterEmail: z.string().email().optional(),
  submitterName: z.string().max(200).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  requestType: z.enum(["bug", "feature", "task", "question", "other"]).optional(),
});

export const publicFormSubmitSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  submittedByName: z.string().max(200).optional(),
});

export const externalReferrerRegisterSchema = z.object({
  orgId: z.string().trim().min(1),
  name: z.string().min(1).max(200).trim(),
  email: z.string().email().max(200).toLowerCase(),
  phone: z.string().max(50).optional(),
});

export const externalReferralSubmitSchema = z.object({
  firstName: z.string().min(1).max(200).trim(),
  lastName: z.string().min(1).max(200).trim(),
  email: z.string().email().max(200).toLowerCase(),
  phone: z.string().max(50).optional(),
  jobPostingId: z.number().int().positive().optional(),
});

export const contactSubmitSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).toLowerCase(),
    company: z.string().trim().max(200),
    phone: z.string().trim().max(50),
    topic: z.enum(["sales", "support", "partnership", "press", "other"]),
    message: z.string().trim().min(1).max(5000),
    cfTurnstileToken: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();

export const waitlistJoinSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(320).toLowerCase(),
    company: z.string().trim().max(200).optional(),
    teamSize: z
      .enum(["1-10", "11-50", "51-200", "201-1000", "1000+"])
      .optional(),
    source: z.enum(["landing", "pricing"]).optional(),
  })
  .strict();

export type ApplyInput = z.infer<typeof applySchema>;
export type OfferRespondInput = z.infer<typeof offerRespondSchema>;
export type RoadmapQueryInput = z.infer<typeof roadmapQuerySchema>;
export type RoadmapVoteInput = z.infer<typeof roadmapVoteSchema>;
export type RoadmapFeedbackInput = z.infer<typeof roadmapFeedbackSchema>;
export type KbListInput = z.infer<typeof kbListQuerySchema>;
export type OrgQueryInput = z.infer<typeof orgQuerySchema>;
export type KbFeedbackInput = z.infer<typeof kbFeedbackSchema>;
export type NpsSubmitInput = z.infer<typeof npsSubmitSchema>;
export type LeadFormBody = z.infer<typeof leadFormBodySchema>;
export type IntakeInput = z.infer<typeof intakeSchema>;
export type PublicFormSubmitInput = z.infer<typeof publicFormSubmitSchema>;
export type ExternalReferrerRegisterInput = z.infer<typeof externalReferrerRegisterSchema>;
export type ExternalReferralSubmitInput = z.infer<typeof externalReferralSubmitSchema>;
export type ContactSubmitInput = z.infer<typeof contactSubmitSchema>;
export type WaitlistJoinInput = z.infer<typeof waitlistJoinSchema>;
