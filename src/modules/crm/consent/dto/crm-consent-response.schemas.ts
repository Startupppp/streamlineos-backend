import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";

export const consentRecordSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  contactId: z.number().int(),
  channel: z.string(),
  status: z.string(),
  legalBasis: z.string().nullable(),
  source: z.string(),
  sourceDetail: z.string().nullable(),
  capturedAt: wireDate(),
  expiresAt: nullableWireDate(),
  recordedByUserId: z.string().nullable(),
  recordedByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const consentListSchema = z.array(consentRecordSchema);

export const consentCountMissingSchema = z.object({
  channel: z.string(),
  count: z.number().int(),
});

export { successSchema };
