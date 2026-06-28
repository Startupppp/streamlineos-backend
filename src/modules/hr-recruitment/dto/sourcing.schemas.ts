import { z } from "zod";

export const createReferralSubmissionSchema = z.object({
  firstName: z.string().min(1).trim(),
  lastName: z.string().min(1).trim(),
  email: z.string().email().toLowerCase(),
  phone: z.string().optional(),
  jobPostingId: z.number().int().positive().optional(),
  relationship: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateReferralSubmissionInput = z.infer<typeof createReferralSubmissionSchema>;

export const updateReferralStatusSchema = z.object({
  status: z.enum(["SUBMITTED", "REVIEWING", "HIRED", "REJECTED", "BONUS_PAID"]).optional(),
  bonusAmount: z.number().positive().optional(),
  bonusEligible: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});
export type UpdateReferralStatusInput = z.infer<typeof updateReferralStatusSchema>;

export const createVendorSchema = z.object({
  name: z.string().min(1).max(200),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(50).optional(),
  website: z.string().url().optional().or(z.literal("")),
  feePercent: z.number().min(0).max(100).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(50).optional(),
  website: z.string().url().optional().or(z.literal("")),
  feePercent: z.number().min(0).max(100).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export const createSubmissionSchema = z.object({
  candidateId: z.number().int().positive(),
  jobPostingId: z.number().int().positive().optional(),
});
export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;

export const updateSubmissionSchema = z.object({
  placementStatus: z.enum(["SUBMITTED", "INTERVIEWING", "PLACED", "REJECTED"]).optional(),
  invoiceStatus: z.enum(["NOT_INVOICED", "INVOICED", "PAID"]).optional(),
  invoiceAmount: z.number().positive().optional(),
  invoiceDate: z.string().optional(),
  paidAt: z.string().optional(),
});
export type UpdateSubmissionInput = z.infer<typeof updateSubmissionSchema>;

export const submissionIdQuerySchema = z.object({
  submissionId: z.coerce.number().int().positive(),
});
export type SubmissionIdQueryInput = z.infer<typeof submissionIdQuerySchema>;

export const headcountListSchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type HeadcountListInput = z.infer<typeof headcountListSchema>;

export const createHeadcountSchema = z.object({
  departmentId: z.number().int().positive().optional(),
  requestedRole: z.string().min(1).max(200),
  level: z.string().max(100).optional(),
  justification: z.string().max(5000).optional(),
  targetDate: z.string().optional(),
  status: z.enum(["DRAFT", "SUBMITTED"]).default("DRAFT"),
});
export type CreateHeadcountInput = z.infer<typeof createHeadcountSchema>;

export const updateHeadcountSchema = z.object({
  requestedRole: z.string().min(1).max(200).optional(),
  level: z.string().max(100).optional(),
  justification: z.string().max(5000).optional(),
  targetDate: z.string().optional(),
  status: z.enum(["DRAFT", "SUBMITTED"]).optional(),
});
export type UpdateHeadcountInput = z.infer<typeof updateHeadcountSchema>;

export const rejectHeadcountSchema = z.object({
  reason: z.string().max(2000).optional(),
});
export type RejectHeadcountInput = z.infer<typeof rejectHeadcountSchema>;
