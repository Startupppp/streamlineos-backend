import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

/**
 * Every component is nullable on the wire and stays nullable all the way to the
 * screen. Null means nobody entered it; "0.00" means the offer states there is
 * none of it. A reader that cannot tell those apart shows a candidate a
 * guaranteed-zero bonus the company never promised either way.
 */
const ctcBreakdownWireFields = {
  ctcFixed: z.string().nullable(),
  ctcVariable: z.string().nullable(),
  ctcJoiningBonus: z.string().nullable(),
  ctcEquityValue: z.string().nullable(),
  ctcEmployerPf: z.string().nullable(),
  ctcGratuity: z.string().nullable(),
};

/**
 * The summed and per-month view, computed in the service. A recruiter sees the
 * reconciliation verdict the candidate does not: it is what tells them the
 * breakdown will block approval before they find out by clicking Approve.
 */
const ctcPreviewSchema = z.object({
  lines: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      recurrence: z.enum(["MONTHLY", "LUMP_SUM"]),
      annual: z.string(),
      monthly: z.string().nullable(),
    }),
  ),
  annualTotal: z.string().nullable(),
  monthlyTotal: z.string().nullable(),
  lumpSumTotal: z.string().nullable(),
  malformed: z.array(z.string()),
  reconciliation: z.object({
    status: z.enum(["MATCHED", "MISMATCHED", "NOT_COMPARABLE"]),
    difference: z.string().nullable(),
    message: z.string().nullable(),
  }),
});

export const candidateOfferSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  offeredBy: z.string().nullable(),
  offerStatus: z.string(),
  offeredSalary: z.string().nullable(),
  offeredDesignation: z.string().nullable(),
  ...ctcBreakdownWireFields,
  joiningDate: z.string().nullable(),
  offerLetterUrl: z.string().nullable(),
  validUntil: z.string().nullable(),
  notes: z.string().nullable(),
  sentAt: nullableWireDate(),
  viewedAt: nullableWireDate(),
  respondedAt: nullableWireDate(),
  approvedBy: z.string().nullable(),
  approvedAt: nullableWireDate(),
  approvalRemarks: z.string().nullable(),
  acceptanceToken: z.string().nullable(),
  acceptanceTokenExpiresAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/**
 * A separate shape rather than an optional field on the row above, because the
 * difference is real: the LIST route computes a preview for every offer, and the
 * single-offer routes return the row the write produced. Declaring `ctcPreview`
 * optional on both would make the contract unable to say which is which — and a
 * contract that cannot fail is the documentation-only state `@ResponseSchema`
 * was built to get out of.
 */
export const candidateOfferWithPreviewSchema = candidateOfferSchema.extend({
  ctcPreview: ctcPreviewSchema,
});

export const offerVersionSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  offerId: z.number().int(),
  versionNumber: z.number().int(),
  offeredSalary: z.string().nullable(),
  offeredDesignation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  notes: z.string().nullable(),
  changeReason: z.string().nullable(),
  changedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const offerNegotiationSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  offerId: z.number().int(),
  direction: z.string(),
  proposedSalary: z.string().nullable(),
  proposedJoiningDate: z.string().nullable(),
  message: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const offerListItemSchema = z.object({
  id: z.number().int(),
  candidateId: z.number().int(),
  candidateFirstName: z.string(),
  candidateLastName: z.string(),
  candidateEmail: z.string(),
  jobPostingId: z.number().int().nullable(),
  jobTitle: z.string().nullable(),
  offerStatus: z.string(),
  offeredSalary: z.string().nullable(),
  offeredDesignation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  validUntil: z.string().nullable(),
  sentAt: nullableWireDate(),
  respondedAt: nullableWireDate(),
  createdAt: wireDate(),
});

export const offerListResponseSchema = z.object({
  items: z.array(offerListItemSchema),
  total: z.number().int(),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});
