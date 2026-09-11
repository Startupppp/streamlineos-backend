import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

const principalGroupItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  orgUnitId: z.string().nullable(),
  createdAt: wireDate(),
  memberCount: z.number().int(),
  roleCount: z.number().int(),
});

/** `PrincipalGroupsService.list` */
export const principalGroupListResponseSchema = z.object({
  data: z.array(principalGroupItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

/** `PrincipalGroupsService.create` — full principalGroups row. */
export const createGroupResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  kind: z.string(),
  orgUnitId: z.string().nullable(),
  name: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `PrincipalGroupsService.rename` / addMember / removeMember / assignRole / unassignRole */
export const groupMutationResponseSchema = z.object({ success: z.literal(true) });

/** `PrincipalGroupsService.getMembers` */
export const groupMembersResponseSchema = z.array(
  z.object({
    membershipId: z.number().int(),
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string(),
    image: z.string().nullable(),
  }),
);

/** `PrincipalGroupsService.getAssignedRoles` */
export const groupAssignedRolesResponseSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    rank: z.number().int(),
    moduleKey: z.string().nullable(),
  }),
);
