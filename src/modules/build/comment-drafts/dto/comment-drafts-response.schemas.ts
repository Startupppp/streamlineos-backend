import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const commentDraftSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  membershipId: z.number().int().nullable(),
  ticketId: z.number().int(),
  body: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const deletedSchema = z.object({ deleted: z.boolean() });
