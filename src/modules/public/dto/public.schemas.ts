import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

/**
 * A form field that reached us through `multipart/form-data` arrives as a
 * string, because that is the only thing the wire format carries. The apply
 * endpoint accepts both encodings — JSON from a script, multipart from the
 * careers form that attaches a résumé — so the two boolean/object fields
 * coerce rather than being declared twice.
 *
 * `z.coerce.boolean()` is deliberately NOT used: it is `Boolean(value)`, and
 * `Boolean("false")` is `true`. Consent is the field where that would matter.
 */
const consentField = z
  .union([
    z.boolean(),
    z.enum(["true", "false", "on", "off", "1", "0"]).transform((v) => v === "true" || v === "on" || v === "1"),
  ])
  .refine((value) => value === true, {
    message: "You must consent to your data being processed before applying.",
  });

const screeningAnswersField = z
  .union([
    z.record(z.string().max(100), z.string().max(2000)),
    z
      .string()
      .max(20_000)
      .transform((raw, ctx): Record<string, string> => {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            ctx.addIssue({ code: "custom", message: "answers must be a JSON object" });
            return z.NEVER;
          }
          const out: Record<string, string> = {};
          for (const [key, value] of Object.entries(parsed)) out[key] = String(value);
          return out;
        } catch {
          ctx.addIssue({ code: "custom", message: "answers must be valid JSON" });
          return z.NEVER;
        }
      }),
  ]);

export const applySchema = z.object({
  name: z.string().min(1).max(200).trim(),
  email: z.string().email().max(200).toLowerCase(),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().url().max(500).optional(),
  coverLetter: z.string().max(5000).optional(),
  resumeUrl: z.string().url().max(500).optional(),
  /**
   * Required, and required to be `true`. DPDP consent is the lawful basis for
   * holding a candidate's file at all, so an application without it is not a
   * weaker application — it is one we may not store.
   */
  consent: consentField,
  /** Answers to `job_postings.screening_questions`, keyed by question id. */
  answers: screeningAnswersField.optional(),
}).strict();

export const offerRespondSchema = z.object({
  action: z.enum(["accept", "decline", "counter"]),
  declineReason: z.string().max(1000).optional(),
  counterSalary: z.number().positive().optional(),
  counterMessage: z.string().max(2000).optional(),
}).strict();

export const roadmapQuerySchema = z.object({
  org: z.string().trim().min(1),
}).strict();

export const roadmapVoteSchema = z.object({
  type: z.enum(["roadmap", "feedback"]),
  id: z.number().int().positive(),
  voterKey: z.string().trim().min(8).max(100),
}).strict();

export const roadmapFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().optional(),
}).strict();

export const kbListQuerySchema = z.object({
  org: z.string().min(1),
  categoryId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  pageSize: pageSizeField(50, 100),
  cursor: z.string().optional(),
}).strict();

export const orgQuerySchema = z.object({
  org: z.string().min(1),
}).strict();

export const kbFeedbackSchema = z.object({
  helpful: z.boolean(),
  comment: z.string().max(1000).optional(),
  visitorId: z.string().max(100).optional(),
}).strict();

export const npsSubmitSchema = z.object({
  score: z.number().int().min(0).max(10),
  comment: z.string().max(2000).optional(),
  name: z.string().max(200).optional(),
  email: z
    .union([z.string().email("Please enter a valid email address").max(320), z.literal("")])
    .optional(),
}).strict();

export const leadFormBodySchema = z.record(z.string(), z.unknown());

export const intakeSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  submitterEmail: z.string().email().optional(),
  submitterName: z.string().max(200).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  requestType: z.enum(["bug", "feature", "task", "question", "other"]).optional(),
}).strict();

export const publicFormSubmitSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  submittedByName: z.string().max(200).optional(),
}).strict();

export const externalReferrerRegisterSchema = z.object({
  orgId: z.string().trim().min(1),
  name: z.string().min(1).max(200).trim(),
  email: z.string().email().max(200).toLowerCase(),
  phone: z.string().max(50).optional(),
}).strict();

export const externalReferralSubmitSchema = z.object({
  firstName: z.string().min(1).max(200).trim(),
  lastName: z.string().min(1).max(200).trim(),
  email: z.string().email().max(200).toLowerCase(),
  phone: z.string().max(50).optional(),
  jobPostingId: z.number().int().positive().optional(),
}).strict();

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
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320).toLowerCase(),
    organization: z.string().trim().max(200).optional(),
    role: z.string().trim().max(120).optional(),
    teamSize: z
      .enum(["1-10", "11-50", "51-200", "201-500", "500+"])
      .optional(),
    notes: z.string().trim().max(2000).optional(),
    cfTurnstileToken: z.string().trim().min(1).max(2048).optional(),
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


/**
 * Claiming a waitlist invitation.
 *
 * Ticket 13. Note what is *not* here: an email address. It comes from the entry
 * the token identifies, so somebody holding a token for one address cannot
 * provision a tenant for another.
 */
export const waitlistClaimSchema = z
  .object({
    token: z.string().min(32).max(128),
    firstName: z.string().min(1).max(100),
    lastName: z.string().max(100).optional(),
    companyName: z.string().min(1).max(200),
    /** Decides the region the tenant is placed in; see ticket 09. */
    country: z.string().length(2).optional(),
  })
  .strict();
export type WaitlistClaimInput = z.infer<typeof waitlistClaimSchema>;

export const waitlistAdmitSchema = z.object({ entryId: z.coerce.number().int().positive() }).strict();
export type WaitlistAdmitInput = z.infer<typeof waitlistAdmitSchema>;
