import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";
import { idCursorSchema } from "../../../common/pagination/cursor.schema";

/** "team" resolves teammates from org_unit_members (kind = TEAM) inside applyScope. */
const dataScopeSchema = z.enum(["all", "team", "own", "none"]);
const moduleKeyRegex = /^[a-z][a-z0-9_-]*$/;

export const moduleKeyParamSchema = z.object({
  moduleKey: z.string().min(1).max(32).regex(moduleKeyRegex),
});

export const moduleRoleParamSchema = z.object({
  moduleKey: z.string().min(1).max(32).regex(moduleKeyRegex),
  roleId: z.coerce.number().int().positive(),
});

export const moduleGroupParamSchema = z.object({
  moduleKey: z.string().min(1).max(32).regex(moduleKeyRegex),
  groupId: z.coerce.number().int().positive(),
});

export const moduleGroupMemberParamSchema = z.object({
  moduleKey: z.string().min(1).max(32).regex(moduleKeyRegex),
  groupId: z.coerce.number().int().positive(),
  userId: z.string().min(1),
});

export const flatMemberParamSchema = z.object({
  moduleKey: z.string().min(1).max(32).regex(moduleKeyRegex),
  userId: z.string().min(1),
});

export const setModuleRolePermissionsSchema = z.object({
  version: z.number().int().positive(),
  items: z
    .array(
      z.object({
        permissionKey: z.string().min(1).max(120),
        scope: dataScopeSchema.default("all"),
      }),
    )
    .max(300),
});

export const createModuleGroupSchema = z.object({
  name: z.string().min(1).max(100),
});

export const renameModuleGroupSchema = z.object({
  name: z.string().min(1).max(100),
});

export const addModuleGroupMemberSchema = z.object({
  userId: z.string().min(1),
});

export const initiateOwnershipTransferSchema = z.object({
  toUserId: z.string().min(1),
});

export const listMembersQuerySchema = z.object({
  pageSize: pageSizeField(20),
  userId: z.string().min(1).max(64).optional(),
  cursor: idCursorSchema,
});

export const memberCandidatesQuerySchema = z.object({
  pageSize: pageSizeField(20),
  search: z.string().trim().max(100).default(""),
  userId: z.string().min(1).max(64).optional(),
  excludeAssigned: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value !== "false"),
  cursor: idCursorSchema,
});

export const addFlatMemberSchema = z.object({
  userId: z.string().min(1),
  groupIds: z
    .array(z.number().int().positive())
    .min(1, "Select at least one group to grant module access")
    .max(50),
});

export const updateMemberGroupsSchema = z.object({
  groupIds: z
    .array(z.number().int().positive())
    .min(1, "A member needs at least one group — remove them from the module instead")
    .max(50),
});

export const listGroupsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
});

export const auditLogQuerySchema = z.object({
  limit: pageSizeField(20),
  cursor: z.string().optional(),
});

export type ModuleKeyParam = z.infer<typeof moduleKeyParamSchema>;
export type ModuleRoleParam = z.infer<typeof moduleRoleParamSchema>;
export type ModuleGroupParam = z.infer<typeof moduleGroupParamSchema>;
export type ModuleGroupMemberParam = z.infer<typeof moduleGroupMemberParamSchema>;
export type FlatMemberParam = z.infer<typeof flatMemberParamSchema>;
export type SetModuleRolePermissionsInput = z.infer<typeof setModuleRolePermissionsSchema>;
export type CreateModuleGroupInput = z.infer<typeof createModuleGroupSchema>;
export type RenameModuleGroupInput = z.infer<typeof renameModuleGroupSchema>;
export type AddModuleGroupMemberInput = z.infer<typeof addModuleGroupMemberSchema>;
export type InitiateOwnershipTransferInput = z.infer<typeof initiateOwnershipTransferSchema>;
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;
export type MemberCandidatesQuery = z.infer<typeof memberCandidatesQuerySchema>;
export type AddFlatMemberInput = z.infer<typeof addFlatMemberSchema>;
export type UpdateMemberGroupsInput = z.infer<typeof updateMemberGroupsSchema>;
export type ListGroupsQuery = z.infer<typeof listGroupsQuerySchema>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const standingMemberParamSchema = z.object({
  moduleKey: z.string().min(1).max(32).regex(moduleKeyRegex),
  membershipId: z.coerce.number().int().positive(),
});

export const directTransferOwnerSchema = z.object({
  toMembershipId: z.number().int().positive(),
});

export type StandingMemberParam = z.infer<typeof standingMemberParamSchema>;
export type DirectTransferOwnerInput = z.infer<typeof directTransferOwnerSchema>;
