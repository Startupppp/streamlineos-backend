import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

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
  /**
   * True when the AI gateway was unavailable and a regex fallback produced
   * `parsed`. Present in the contract so the screen can label it, rather than
   * showing a heuristic guess as an AI extraction.
   */
  heuristic: z.boolean(),
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
