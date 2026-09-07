import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../../common/openapi/response-envelopes";

export const approvalPolicySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  recordType: z.string(),
  minAmount: z.string().nullable(),
  approverRole: z.string().nullable(),
  approverUserId: z.string().nullable(),
  approverMembershipId: z.number().int().nullable(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const approvalPolicyListResponseSchema = cursorPageSchema(approvalPolicySchema);

export const approvalPolicyDeleteResponseSchema = z.object({ deleted: z.literal(true) });

const approvalRequestBaseSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  recordType: z.string(),
  recordId: z.number().int(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
  requestedBy: z.string(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: nullableWireDate(),
  decisionComment: z.string().nullable(),
  createdAt: wireDate(),
});

const approvalRequestEnrichedSchema = approvalRequestBaseSchema.extend({
  requesterDisplayName: z.string(),
  recordLabel: z.string().nullable(),
  recordAmount: z.string().nullable(),
});

export const approvalListResponseSchema = cursorPageSchema(approvalRequestEnrichedSchema);

export const approvalCountsResponseSchema = z.object({
  PENDING: z.number().int(),
  APPROVED: z.number().int(),
  REJECTED: z.number().int(),
});

export const approvalDecisionResponseSchema = approvalRequestBaseSchema;

const auditRowSchema = z.object({
  id: z.number().int(),
  action: z.string(),
  userId: z.string().nullable(),
  orgId: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  metadata: z.unknown().nullable(),
  createdAt: wireDate(),
});

export const auditListResponseSchema = cursorPageSchema(auditRowSchema);

export const auditTimelineResponseSchema = z.array(auditRowSchema);

export const exchangeRateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  fromCurrency: z.string(),
  toCurrency: z.string(),
  rate: z.string(),
  asOfDate: z.string(),
  createdAt: wireDate(),
});

export const exchangeRateListResponseSchema = cursorPageSchema(exchangeRateSchema);

export { successSchema };
