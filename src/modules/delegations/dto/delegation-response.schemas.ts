import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

const delegationItemSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  delegatorMembershipId: z.number().int(),
  delegateeMembershipId: z.number().int(),
  startsAt: wireDate(),
  endsAt: nullableWireDate(),
  reason: z.string().nullable(),
  status: z.string(),
  revokedAt: nullableWireDate(),
  revokedBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  permissions: z.array(z.string()),
  delegatorName: z.string().nullable(),
  delegateeName: z.string().nullable(),
  lifecycle: z.enum(["ACTIVE", "SCHEDULED", "EXPIRED", "REVOKED"]),
});

export const delegationsPageSchema = cursorPageSchema(delegationItemSchema);

export const delegationRowSchema = delegationItemSchema;
