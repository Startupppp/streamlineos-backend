import { z } from "zod";

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
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const addFlatMemberSchema = z.object({
  userId: z.string().min(1),
  groupIds: z.array(z.number().int().positive()).max(50).optional(),
});

export const updateMemberGroupsSchema = z.object({
  groupIds: z.array(z.number().int().positive()).max(50),
});

export const auditLogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
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
export type AddFlatMemberInput = z.infer<typeof addFlatMemberSchema>;
export type UpdateMemberGroupsInput = z.infer<typeof updateMemberGroupsSchema>;
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
