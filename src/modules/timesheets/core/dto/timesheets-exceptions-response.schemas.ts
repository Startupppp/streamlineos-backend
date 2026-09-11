import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const exceptionItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  periodId: z.number().int().nullable(),
  entryId: z.number().int().nullable(),
  rule: z.string(),
  severity: z.string(),
  status: z.string(),
  message: z.string(),
  details: z.unknown().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolvedByMembershipId: z.number().int().nullable(),
  resolvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: z.object({
    membershipId: z.number().int().nullable(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
});

export const exceptionsListResponseSchema = cursorPageSchema(exceptionItemSchema);

export const exceptionsSummaryResponseSchema = z.object({
  total: z.number().int(),
  byStatus: z.record(z.string(), z.number().int()),
  bySeverity: z.record(z.string(), z.number().int()),
  openBySeverity: z.record(z.string(), z.number().int()),
});

export const exceptionResolutionResponseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userMembershipId: z.number().int().nullable(),
  periodId: z.number().int().nullable(),
  entryId: z.number().int().nullable(),
  rule: z.string(),
  severity: z.string(),
  status: z.string(),
  message: z.string(),
  details: z.unknown().nullable(),
  ownerMembershipId: z.number().int().nullable(),
  dueDate: z.string().nullable(),
  resolutionReason: z.string().nullable(),
  resolvedByMembershipId: z.number().int().nullable(),
  resolvedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const detectorResponseSchema = z.object({
  week: z.object({ start: z.string(), end: z.string() }),
  candidates: z.number().int(),
  created: z.number().int(),
});
