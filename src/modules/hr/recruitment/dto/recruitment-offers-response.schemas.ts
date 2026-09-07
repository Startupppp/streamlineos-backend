import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const candidateOfferSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  candidateId: z.number().int(),
  jobPostingId: z.number().int().nullable(),
  offeredBy: z.string().nullable(),
  offerStatus: z.string(),
  offeredSalary: z.string().nullable(),
  offeredDesignation: z.string().nullable(),
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
