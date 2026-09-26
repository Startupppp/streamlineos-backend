import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const kbPageGrantItemSchema = z.object({
  id: z.number().int(),
  pageId: z.number().int(),
  membershipId: z.number().int().nullable(),
  role: z.string().nullable(),
  access: z.string(),
  grantedByMembershipId: z.number().int().nullable(),
  createdAt: wireDate(),
  revokedAt: nullableWireDate(),
  granteeName: z.string().nullable(),
  granteeEmail: z.string().nullable(),
  granteeImage: z.string().nullable(),
});

export type KbPageGrantItem = z.infer<typeof kbPageGrantItemSchema>;

export const kbPageGrantsPageSchema = cursorPageSchema(kbPageGrantItemSchema);
