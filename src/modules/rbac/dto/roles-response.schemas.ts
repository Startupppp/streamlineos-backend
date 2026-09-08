import { z } from "zod";
import { dataScopeSchema } from "./rbac.schemas";
import { moduleKeySchema, permissionKeySchema } from "./rbac-response.schemas";
import { wireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema } from "../../../common/openapi/response-envelopes";

const successResponseSchema = z.object({ success: z.literal(true) });

export const roleTemplateCatalogResponseSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(100),
        moduleKey: moduleKeySchema.nullable(),
        permissions: z.array(permissionKeySchema).max(500),
      })
      .strict(),
  )
  .max(100);

export const seededRolesResponseSchema = z
  .object({
    created: z.array(z.string().min(1).max(100)).max(100),
    skipped: z.array(z.string().min(1).max(100)).max(100),
  })
  .strict();

const roleItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  rank: z.number().int(),
  orgId: z.string(),
  version: z.number().int(),
  isSystem: z.boolean(),
  moduleKey: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  description: z.string().nullable(),
  permissionCount: z.number().int(),
  memberCount: z.number().int(),
});

/** `RolesService.getRoles` */
export const roleListResponseSchema = z.object({
  data: z.array(roleItemSchema),
  pagination: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

/** `RolesService.getRole` */
export const roleDetailResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  rank: z.number().int(),
  orgId: z.string(),
  version: z.number().int(),
  isSystem: z.boolean(),
  moduleKey: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  description: z.string().nullable(),
});

/** `RolesQueryService.getRoleAnalytics` */
export const roleAnalyticsResponseSchema = z.object({
  totalRoles: z.number().int(),
  customRoles: z.number().int(),
  systemRoles: z.number().int(),
  totalPermissions: z.number().int(),
  usersAssigned: z.number().int(),
  recentChanges: z.number().int(),
});

/** `RolePermissionService.getPermissionsMatrix` */
export const permissionsMatrixResponseSchema = z.array(
  z.object({
    roleId: z.number().int(),
    roleName: z.string(),
    roleSlug: z.string(),
    permissions: z.array(z.string()),
  }),
);

const simulationCandidateItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  designation: z.string().nullable(),
});

/** `RolesQueryService.listSimulationCandidates` */
export const simulationCandidatesResponseSchema = cursorPageSchema(simulationCandidateItemSchema);

/** `AccessService.resolveUserPermissions` — simulate access for target user. */
export const simulateAccessResponseSchema = z.object({
  userId: z.string(),
  permissions: z.array(z.string()),
  scopes: z.record(z.string(), dataScopeSchema),
  isOrgOwner: z.boolean(),
});

/** `RoleSeedService.materializeTemplate` — returns created role row. */
export const materializeTemplateResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  rank: z.number().int(),
  orgId: z.string(),
  isSystem: z.boolean(),
  moduleKey: z.string().nullable(),
  description: z.string().nullable(),
  version: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `RolesQueryService.listAssignableDepartments` */
export const assignableDepartmentsResponseSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    kind: z.string(),
  }),
);

/** `RolesService.updateRole` / `deleteRole` */
export const roleMutationResponseSchema = successResponseSchema;

/** `RolePermissionService.getRolePermissions` */
export const rolePermissionsResponseSchema = z.array(
  z.object({
    permissionKey: z.string(),
    scope: dataScopeSchema,
  }),
);

/** `RolePermissionService.setRolePermissions` */
export const setRolePermissionsResponseSchema = z.object({
  success: z.literal(true),
  version: z.number().int(),
});

const roleMemberItemSchema = z.object({
  id: z.string(),
  principalType: z.string(),
  principalId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  via: z.string(),
  groupId: z.string().nullable(),
  groupName: z.string().nullable(),
});

/** `RoleMemberService.getRoleMembers` */
export const roleMembersResponseSchema = z.array(roleMemberItemSchema);

/** `RoleMemberService.addRoleMember` / `removeRoleMember` */
export const roleMemberMutationResponseSchema = successResponseSchema;
