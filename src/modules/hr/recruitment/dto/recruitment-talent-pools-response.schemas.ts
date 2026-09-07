import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const talentPoolSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const talentPoolMemberRowSchema = z.object({
  id: z.number().int(),
  poolId: z.number().int(),
  candidateId: z.number().int(),
  orgId: z.string(),
  notes: z.string().nullable(),
  addedBy: z.string().nullable(),
  addedAt: wireDate(),
});

export const talentPoolMemberItemSchema = z.object({
  membershipId: z.number().int(),
  notes: z.string().nullable(),
  addedAt: wireDate(),
  candidateId: z.number().int(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  currentCompany: z.string().nullable(),
  currentRole: z.string().nullable(),
  status: z.string(),
});

export const talentPoolMembersResponseSchema = cursorPageSchema(talentPoolMemberItemSchema);
