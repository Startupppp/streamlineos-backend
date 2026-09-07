import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const timesheetAuditEventSchema = z.object({
  id: z.number().int(),
  actorMembershipId: z.number().int().nullable(),
  actorName: z.string().nullable(),
  entityType: z.string(),
  entityId: z.string(),
  action: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: z.string().nullable(),
  createdAt: wireDate(),
});

export const auditListResponseSchema = cursorPageSchema(timesheetAuditEventSchema);

export const auditVerifyResponseSchema = z.union([
  z.object({
    valid: z.literal(true),
    checked: z.number().int(),
    verified: z.number().int(),
    legacyRows: z.number().int(),
  }),
  z.object({
    valid: z.literal(false),
    brokenAtId: z.number().int(),
    checked: z.number().int(),
    legacyRows: z.number().int(),
  }),
]);
