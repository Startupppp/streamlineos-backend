import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const createCalibrationSchema = z.object({
  jobPostingId: z.number().int().positive().optional(),
  scheduledAt: z.string().datetime().optional(),
  participantIds: z.array(z.string()).max(30).default([]),
  notes: z.string().max(5000).optional(),
}).strict();
export type CreateCalibrationInput = z.infer<typeof createCalibrationSchema>;

export const updateCalibrationSchema = z.object({
  id: z.number().int().positive(),
  scheduledAt: z.string().datetime().optional().nullable(),
  status: z.enum(["pending", "scheduled", "completed", "cancelled"]).optional(),
  notes: z.string().max(5000).optional().nullable(),
  decision: z.enum(["STRONG_HIRE", "HIRE", "NO_HIRE", "HOLD"]).optional().nullable(),
  participantIds: z.array(z.string()).max(30).optional(),
}).strict();
export type UpdateCalibrationInput = z.infer<typeof updateCalibrationSchema>;

export const createReferralSchema = z.object({
  referredBy: z.string().min(1),
  relationship: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  bonusEligible: z.boolean().default(true),
  bonusAmount: z.number().min(0).optional(),
}).strict();
export type CreateReferralInput = z.infer<typeof createReferralSchema>;

export const updateReferralSchema = z.object({
  id: z.number().int().positive(),
  bonusEligible: z.boolean().optional(),
  bonusAmount: z.number().min(0).optional().nullable(),
  bonusPaidAt: z.string().datetime().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
}).strict();
export type UpdateReferralInput = z.infer<typeof updateReferralSchema>;

export const createReferenceCheckSchema = z.object({
  referenceName: z.string().min(1).max(200),
  referenceDesignation: z.string().max(200).optional(),
  referenceCompany: z.string().max(200).optional(),
  referenceEmail: z.string().email().optional(),
  referencePhone: z.string().max(30).optional(),
  relationship: z.string().max(100).optional(),
  notes: z.string().optional(),
}).strict();
export type CreateReferenceCheckInput = z.infer<typeof createReferenceCheckSchema>;

export const updateReferenceCheckSchema = z.object({
  status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "DECLINED"]).optional(),
  outcome: z.string().max(500).nullable().optional(),
  notes: z.string().nullable().optional(),
  contactedAt: z.string().datetime().optional(),
  referenceDesignation: z.string().max(200).nullable().optional(),
  referenceCompany: z.string().max(200).nullable().optional(),
  referenceEmail: z.string().email().nullable().optional(),
  referencePhone: z.string().max(30).nullable().optional(),
}).strict();
export type UpdateReferenceCheckInput = z.infer<typeof updateReferenceCheckSchema>;

export const generateDocumentSchema = z.object({
  templateId: z.number().int().positive("Template ID is required"),
  variables: z.record(z.string(), z.string()).default({}),
}).strict();
export type GenerateDocumentInput = z.infer<typeof generateDocumentSchema>;

export const rolloutDocumentsSchema = z.object({
  templateIds: z.array(z.number().int().positive()).min(1, "Select at least one template").max(20),
  variables: z.record(z.string(), z.string()).default({}),
  sendEmail: z.boolean().default(true),
  acceptanceDeadline: z.string().datetime({ offset: true }).optional(),
}).strict();
export type RolloutDocumentsInput = z.infer<typeof rolloutDocumentsSchema>;

const VAULT_DOCUMENT_TYPES = ["AADHAR", "PAN", "PASSPORT", "CERTIFICATE", "OFFER_LETTER", "OTHER"] as const;

export const addVaultDocumentSchema = z.object({
  filename: z.string().min(1),
  s3Key: z.string().min(1),
  fileUrl: z.string().url(),
  fileType: z.string().min(1),
  fileSize: z.number().int().nonnegative(),
  documentType: z.enum(VAULT_DOCUMENT_TYPES).optional(),
}).strict();
export type AddVaultDocumentInput = z.infer<typeof addVaultDocumentSchema>;

const OFFER_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVAL_REJECTED",
  "SENT",
  "VIEWED",
  "ACCEPTED",
  "DECLINED",
  "COUNTERED",
  "EXPIRED",
] as const;

export const offerListSchema = z.object({
  status: z.enum(OFFER_STATUSES).optional(),
  cursor: z.string().optional(),
  pageSize: pageSizeField(20, 100),
}).strict();
export type OfferListInput = z.infer<typeof offerListSchema>;

export const createOfferSchema = z
  .object({
    jobPostingId: z.number().int().positive().optional(),
    offeredSalary: z.number().positive("Offer salary must be greater than 0").optional(),
    offeredDesignation: z.string().trim().min(1).max(200).optional(),
    joiningDate: z
      .string()
      .optional()
      .refine(
        (d) => !d || new Date(d) >= new Date(new Date().toDateString()),
        "Joining date cannot be in the past",
      ),
    offerLetterUrl: z.string().url("Offer letter URL must be valid").optional().or(z.literal("")),
    validUntil: z
      .string()
      .optional()
      .refine(
        (d) => !d || new Date(d) >= new Date(new Date().toDateString()),
        "Offer expiry cannot be in the past",
      ),
    notes: z.string().max(5000).optional(),
  }).strict()
  .refine(
    (d) => {
      if (d.joiningDate && d.validUntil) {
        // validUntil is an expiry for the offer letter, not the joining date;
        // only reject clearly invalid relative dates (expiry before joining is allowed).
        return !Number.isNaN(new Date(d.joiningDate).getTime())
          && !Number.isNaN(new Date(d.validUntil).getTime());
      }
      return true;
    },
    { message: "Joining date and offer expiry must be valid dates", path: ["validUntil"] },
  );
export type CreateOfferInput = z.infer<typeof createOfferSchema>;

export const updateOfferSchema = z.object({
  offerStatus: z
    .enum(["DRAFT", "SENT", "VIEWED", "ACCEPTED", "DECLINED", "COUNTERED", "EXPIRED"])
    .optional(),
  offeredSalary: z.number().positive().optional(),
  offeredDesignation: z.string().min(1).optional(),
  joiningDate: z.string().optional(),
  offerLetterUrl: z.string().url().optional(),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
  sentAt: z.string().optional(),
  viewedAt: z.string().optional(),
  respondedAt: z.string().optional(),
}).strict();
export type UpdateOfferInput = z.infer<typeof updateOfferSchema>;

export const approvalRemarksSchema = z.object({
  remarks: z.string().max(2000).optional(),
}).strict();
export type ApprovalRemarksInput = z.infer<typeof approvalRemarksSchema>;

export const createOfferNegotiationSchema = z.object({
  proposedSalary: z.number().positive().optional(),
  proposedJoiningDate: z.string().optional(),
  message: z.string().max(2000).optional(),
  applyToOffer: z.boolean().optional(),
}).strict();
export type CreateOfferNegotiationInput = z.infer<typeof createOfferNegotiationSchema>;
