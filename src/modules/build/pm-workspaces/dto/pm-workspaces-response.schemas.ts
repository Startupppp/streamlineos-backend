import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const pmWorkspaceRowSchema = z.object({
  pmWorkspaceId: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  isDefault: z.boolean(),
  status: z.string(),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const pmWorkspacePageSchema = cursorPageSchema(pmWorkspaceRowSchema);

export const pmWorkspaceMemberRowSchema = z.object({
  pmWorkspaceMembershipId: z.string(),
  orgId: z.string(),
  pmWorkspaceId: z.string(),
  organizationMembershipId: z.number().int(),
  role: z.string(),
  addedAt: wireDate(),
  userId: z.string(),
});

export const pmWorkspaceMemberPageSchema = cursorPageSchema(pmWorkspaceMemberRowSchema);

