import { z } from "zod";
import {
  AttritionRiskSchema,
  ReviewDraftSchema,
  CandidateScoreSchema,
  HelpdeskReplySchema,
  PolicyQaSchema,
  InterviewKitSchema,
  LetterDraftSchema,
  InterviewNotesSummarySchema,
} from "./output.schemas";

const advisoryFields = {
  advisory: z.literal(true),
  disclaimer: z.string(),
};

export const attritionRiskResponseSchema = AttritionRiskSchema.extend(advisoryFields);
export const generateReviewResponseSchema = ReviewDraftSchema.extend(advisoryFields);
export const generateJdResponseSchema = z.object({ description: z.string() });
export const scoreCandidateResponseSchema = CandidateScoreSchema.extend(advisoryFields);
export const helpdeskReplyResponseSchema = HelpdeskReplySchema;

const policyEvidenceCitationSchema = z.object({
  policyId: z.number().int(),
  policyType: z.string(),
  policyName: z.string().nullable(),
  snippet: z.string(),
  path: z.string(),
  source: z.literal("hr_policy_registry"),
});

export const policyQaResponseSchema = PolicyQaSchema.extend({
  citations: z.array(policyEvidenceCitationSchema),
  suggestTicket: z.boolean(),
  capability: z.object({
    mode: z.literal("explain_draft_only"),
    mayInventPolicy: z.boolean(),
    mayApprovePayroll: z.boolean(),
    mayFileStatutory: z.boolean(),
    mayMoveMoney: z.boolean(),
    honestyLabel: z.string(),
    note: z.string(),
  }),
  forbiddenActions: z.array(z.string()),
  advisory: z.literal(true),
  disclaimer: z.string(),
});

export const policyQaCapabilitiesResponseSchema = z.object({
  mode: z.literal("explain_draft_only"),
  mayInventPolicy: z.boolean(),
  mayApprovePayroll: z.boolean(),
  mayFileStatutory: z.boolean(),
  mayMoveMoney: z.boolean(),
  honestyLabel: z.string(),
  note: z.string(),
  forbiddenActions: z.array(z.string()),
  features: z.array(z.object({
    key: z.string(),
    mode: z.string(),
    requiresHumanEscalationWhenNotFound: z.boolean(),
  })),
});

export const interviewKitResponseSchema = InterviewKitSchema.extend(advisoryFields);
export const letterDraftResponseSchema = LetterDraftSchema.extend(advisoryFields);
export const interviewNotesSummaryResponseSchema = InterviewNotesSummarySchema.extend(advisoryFields);
export const acceptCandidateScoreResponseSchema = z.object({ accepted: z.literal(true) });

const kbAnswerSourceSchema = z.object({
  articleId: z.number().int(),
  title: z.string(),
  slug: z.string(),
  attachmentId: z.number().int().nullable(),
  attachmentName: z.string().nullable(),
  similarity: z.number(),
});

export const kbAskResponseSchema = z.object({
  answer: z.string(),
  sources: z.array(kbAnswerSourceSchema),
  hasContext: z.boolean(),
});
