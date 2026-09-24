import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const candidateReferralRowSchema = z.object({
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

export const candidateReferralWithRelationsSchema = candidateReferralRowSchema.extend({
  candidate: z.object({ id: z.number().int(), firstName: z.string(), lastName: z.string(), email: z.string() }).nullable(),
  referrer: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }).nullable(),
  jobPosting: z.object({ id: z.number().int(), title: z.string() }).nullable(),
});

export const vendorListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  website: z.string().nullable(),
  feePercent: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  submissionCount: z.number().int(),
  placements: z.number().int(),
  revenueTotal: z.string(),
});

export const vendorRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  website: z.string().nullable(),
  feePercent: z.string().nullable(),
  status: z.string(),
  contractType: z.string(),
  slaDays: z.number().int().nullable(),
  replacementGuaranteeDays: z.number().int().nullable(),
  portalToken: z.string().nullable(),
  portalTokenExpiresAt: nullableWireDate(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const vendorPortalLinkSchema = z.object({
  portalToken: z.string().nullable(),
  portalTokenExpiresAt: nullableWireDate(),
});

export const vendorSubmissionItemSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  submittedAt: wireDate(),
  placementStatus: z.string(),
  invoiceStatus: z.string(),
  invoiceAmount: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  paidAt: z.string().nullable(),
  billRate: z.string().nullable(),
  payRate: z.string().nullable(),
  contractStartDate: z.string().nullable(),
  contractEndDate: z.string().nullable(),
  candidateFirstName: z.string().nullable(),
  candidateLastName: z.string().nullable(),
  candidateEmail: z.string().nullable(),
  jobTitle: z.string().nullable(),
  /*
    `margin` became three fields. The amount alone could not say whether a
    placement was below cost or simply unpriced, and a desk quoting a percentage
    needs the percentage the client will read — of the bill rate, not the pay.
  */
  marginAmount: z.string().nullable(),
  marginPercent: z.number().nullable(),
  negative: z.boolean(),
});

export const vendorSubmissionRawSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  vendorId: z.number().int(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  submittedAt: wireDate(),
  placementStatus: z.string(),
  invoiceStatus: z.string(),
  invoiceAmount: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  paidAt: z.string().nullable(),
  billRate: z.string().nullable(),
  payRate: z.string().nullable(),
  contractStartDate: z.string().nullable(),
  contractEndDate: z.string().nullable(),
  createdAt: wireDate(),
});

export const headcountRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  orgDepartmentId: z.string().nullable(),
  requestedBy: z.string(),
  requestedByMembershipId: z.number().int().nullable(),
  requestedRole: z.string(),
  level: z.string().nullable(),
  justification: z.string().nullable(),
  targetDate: z.string().nullable(),
  status: z.string(),
  approvedBy: z.string().nullable(),
  approvedByMembershipId: z.number().int().nullable(),
  approvedAt: nullableWireDate(),
  rejectedReason: z.string().nullable(),
  linkedJobPostingId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const headcountListItemSchema = headcountRowSchema.extend({
  departmentName: z.string().nullable(),
  requesterName: z.string().nullable(),
  requesterEmail: z.string().nullable(),
});

export const headcountListPageSchema = cursorPageSchema(headcountListItemSchema);

const externalReferralBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  referrerId: z.number().int(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  status: z.string(),
  rewardAmount: z.string().nullable(),
  rewardPaidAt: nullableWireDate(),
  ipAddress: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const externalReferralRawSchema = externalReferralBaseSchema;

export const externalReferralWithRelationsSchema = externalReferralBaseSchema.extend({
  candidate: z.object({ id: z.number().int(), firstName: z.string(), lastName: z.string(), email: z.string() }).nullable(),
  referrer: z.object({ id: z.number().int(), name: z.string(), email: z.string() }).nullable(),
  jobPosting: z.object({ id: z.number().int(), title: z.string() }).nullable(),
});

export const externalReferrerListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  status: z.string(),
  createdAt: wireDate(),
  referralCount: z.number().int(),
});

export const externalReferrerRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  referralToken: z.string(),
  status: z.string(),
  emailVerifiedAt: nullableWireDate(),
  createdAt: wireDate(),
});
