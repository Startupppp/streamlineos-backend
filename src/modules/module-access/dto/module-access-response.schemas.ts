import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

/**
 * Response contract for `ModuleAccessController` and
 * `UserPermissionGrantsController` handlers.
 *
 * Derived from service interfaces (`StandingEntry`, `ModuleRoleGroup`,
 * `ModuleOwnership`, `GrantableDescriptor`, `FlatModuleMember`, etc.) and
 * confirmed against the Drizzle projections they read.
 *
 * NOT `.strict()`: extra response fields are backward-compatible.
 */

const dataScopeSchema = z.enum(["all", "team", "own", "none"]);

const standingSourceSchema = z.enum([
  "org-owner",
  "org-admin",
  "module-ownership",
  "module-role",
  "direct-grant",
]);

/** `StandingEntry` — `module-standing-roster.service.ts`. */
const standingEntrySchema = z.object({
  membershipId: z.number().int(),
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  rank: z.number().int(),
  scope: dataScopeSchema,
  source: standingSourceSchema,
});

/**
 * `ModuleStandingRosterService.listStanding` — discriminated union: when the
 * module does not support standing the `administrable: false` branch is
 * returned with a human-readable reason; otherwise the full entry list.
 */
export const moduleStandingResponseSchema = z.discriminatedUnion("administrable", [
  z.object({ administrable: z.literal(true), entries: z.array(standingEntrySchema) }),
  z.object({ administrable: z.literal(false), reason: z.string() }),
]);

/**
 * `ModuleStandingRosterService.describeGrantable` — `GrantableDescriptor`.
 */
export const moduleGrantableResponseSchema = z.object({
  grantableRanks: z.array(z.number().int()),
  scopeCeiling: dataScopeSchema,
  canGrantModuleOwnership: z.boolean(),
  isOrgOwner: z.boolean(),
  isOrgAdmin: z.boolean(),
});

/** `ModuleStandingMutationsService.directTransferOwnership` / `grantAdminStanding` / `revokeStanding` */
export const moduleStandingMutationResponseSchema = z.object({ success: z.literal(true) });

/**
 * A single permission from the catalog — `Permission` interface
 * (`permissions/types.ts`). `scopable` and `baselineScope` are optional.
 */
const permissionItemSchema = z.object({
  name: z.string(),
  resource: z.string(),
  action: z.string(),
  description: z.string(),
  scopable: z.boolean().optional(),
  baselineScope: z.enum(["own", "all"]).optional(),
  sensitive: z.literal(true).optional(),
});

/** `ModuleAccessService.listCatalog` — filtered permission catalog for one module. */
export const moduleCatalogResponseSchema = z.array(permissionItemSchema);

/** A role with its current permission grants — `ModuleRoleView` / `ModuleRoleGroup`. */
const moduleRoleItemSchema = z.object({
  roleId: z.number().int(),
  name: z.string(),
  slug: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(z.object({
    permissionKey: z.string(),
    scope: dataScopeSchema,
  })),
});

/** `ModuleAccessService.listRoles` */
export const moduleRolesResponseSchema = z.array(moduleRoleItemSchema);

/** `ModuleAccessService.setRolePermissions` / `setGroupPermissions` */
export const moduleSetPermissionsResponseSchema = z.object({
  success: z.literal(true),
  version: z.number().int(),
});

/**
 * A module group — `ModuleRoleGroup` from
 * `module-access-group-crud.service.ts`. Extends the role shape with
 * `version` and `memberCount`; `permissions` may be empty on creation.
 */
const moduleGroupItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  isSystem: z.boolean(),
  version: z.number().int(),
  memberCount: z.number().int(),
  permissions: z.array(z.object({
    permissionKey: z.string(),
    scope: dataScopeSchema,
  })),
});

/** `ModuleAccessGroupsService.listGroups` — cursor-paged list of groups. */
export const moduleGroupListResponseSchema = cursorPageSchema(moduleGroupItemSchema);

/** `ModuleAccessGroupsService.createGroup` / `renameGroup` */
export const moduleGroupResponseSchema = moduleGroupItemSchema;

/** `ModuleAccessGroupsService.deleteGroup` */
export const moduleGroupDeleteResponseSchema = z.object({ success: z.literal(true) });

/** A group member — `module-access-group-members.service.ts` projection. */
const groupMemberItemSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
});

/** `ModuleAccessGroupsService.listGroupMembers` */
export const moduleGroupMembersResponseSchema = z.array(groupMemberItemSchema);

/** `ModuleAccessGroupsService.addGroupMember` / `removeGroupMember` */
export const moduleGroupMemberMutationResponseSchema = z.object({ success: z.literal(true) });

/**
 * `ModuleAccessService.getCallerPermissions` — the caller's resolved
 * module permissions plus authority facts.
 */
export const moduleCallerPermissionsResponseSchema = z.object({
  permissions: z.array(z.object({ key: z.string(), scope: dataScopeSchema })),
  isOrgOwner: z.boolean(),
  isOrgAdmin: z.boolean(),
  isModuleOwner: z.boolean(),
  isModuleAdmin: z.boolean(),
});

/**
 * `FlatModuleMember` — a roster member with their group memberships.
 * `ModuleAccessRosterService.listMembers` returns
 * `{ data, hasMore, nextCursor }` (top-level, NOT wrapped in pagination).
 */
const flatModuleMemberSchema = z.object({
  membershipId: z.number().int(),
  userId: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  groups: z.array(z.object({ id: z.number().int(), name: z.string() })),
});

/**
 * `ModuleAccessRosterService.listMembers` — uses the same fields as
 * buildIdCursorPage but flattened: no `pagination` wrapper.
 */
export const moduleRosterResponseSchema = z.object({
  data: z.array(flatModuleMemberSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

/** `ModuleAccessFlatMembersService.addMember` / `updateMemberGroups` / `removeMember` */
export const moduleRosterMutationResponseSchema = z.object({ success: z.literal(true) });

/**
 * `ModuleAccessRosterService.listMemberCandidates` — users eligible to be
 * added. Uses `buildIdCursorPage`, so `nextCursor` is a numeric-or-null.
 */
export const moduleMemberCandidatesResponseSchema = z.object({
  data: z.array(z.object({
    userId: z.string(),
    displayName: z.string(),
    email: z.string(),
    avatarUrl: z.string().nullable(),
  })),
  hasMore: z.boolean(),
  nextCursor: z.number().int().nullable(),
});

/**
 * `ModuleAccessOwnershipService.getOwnership` — `ModuleOwnership`.
 * `pendingTransfer` is null when no transfer is in flight.
 */
export const moduleOwnershipResponseSchema = z.object({
  moduleKey: z.string(),
  ownerId: z.string(),
  ownerDisplayName: z.string(),
  ownerEmail: z.string(),
  pendingTransfer: z.object({
    transferId: z.string(),
    toUserId: z.string(),
    toDisplayName: z.string(),
    toEmail: z.string(),
    initiatedAt: z.string(),
  }).nullable(),
});

/** `ModuleAccessOwnershipService.initiateTransfer` / `cancelTransfer` */
export const moduleOwnershipMutationResponseSchema = z.object({ success: z.literal(true) });

/**
 * `ModuleAccessService.getAuditLog` — cursor-paged audit trail.
 * `createdAt` is a pre-formatted ISO string (`.toISOString()` in the service),
 * not a `Date` object, so `z.string()` is correct here.
 */
export const moduleAuditLogResponseSchema = z.object({
  data: z.array(z.object({
    id: z.number().int(),
    action: z.string(),
    actorUserId: z.string(),
    actorName: z.string(),
    actorEmail: z.string(),
    targetId: z.string().nullable(),
    targetType: z.string().nullable(),
    targetName: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    ipAddress: z.string().nullable(),
    createdAt: z.string(),
  })),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

/** `UserPermissionGrantsService.listGrants` */
export const userGrantListResponseSchema = z.object({
  grants: z.array(z.object({
    permissionKey: z.string(),
    scope: dataScopeSchema,
    reason: z.string().nullable(),
    createdAt: wireDate(),
  })),
});

/** `UserPermissionGrantsService.setGrants` */
export const userGrantSetResponseSchema = z.object({
  success: z.literal(true),
  granted: z.number().int(),
});

/** `UserPermissionGrantsService.removeGrant` */
export const userGrantRemoveResponseSchema = z.object({ success: z.literal(true) });
