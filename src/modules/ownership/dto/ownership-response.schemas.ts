import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../common/openapi/response-envelopes";

const moduleOwnershipItemSchema = z.object({
  moduleKey: z.string(),
  ownerMembershipId: z.number().int().nullable(),
  ownerUserId: z.string().nullable(),
  ownerName: z.string().nullable(),
  ownerEmail: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const moduleOwnershipListSchema = z.array(moduleOwnershipItemSchema);

export const moduleOwnershipSchema = moduleOwnershipItemSchema.nullable();

export const transferInitiatedSchema = z.object({
  transferId: z.string(),
  expiresAt: wireDate(),
});

const incomingTransferItemSchema = z.object({
  id: z.string(),
  scope: z.string(),
  moduleKey: z.string().nullable(),
  fromMembershipId: z.number().int(),
  initiatedByMembershipId: z.number().int(),
  toMembershipId: z.number().int(),
  status: z.string(),
  initiatedAt: wireDate(),
  expiresAt: wireDate(),
  reason: z.string().nullable(),
  fromName: z.string().nullable(),
  fromEmail: z.string().nullable(),
});

export const incomingTransfersSchema = z.object({
  data: z.array(incomingTransferItemSchema),
});

const transferItemSchema = z.object({
  id: z.string(),
  scope: z.string(),
  moduleKey: z.string().nullable(),
  fromMembershipId: z.number().int(),
  initiatedByMembershipId: z.number().int(),
  toMembershipId: z.number().int(),
  status: z.string(),
  initiatedAt: wireDate(),
  respondedAt: nullableWireDate(),
  expiresAt: wireDate(),
  reason: z.string().nullable(),
});

export const transfersPageSchema = cursorPageSchema(transferItemSchema);

export { successSchema };
