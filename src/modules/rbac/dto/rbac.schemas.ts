import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../common/pagination/list-query.schema";

/** "team" resolves teammates from org_unit_members (kind = TEAM) inside applyScope. */
export const dataScopeSchema = z.enum(["all", "team", "own", "none"]);

export const rolePermissionsQuerySchema = z.object({
  role: z.string().min(1).max(100),
});

export const assignRolePermissionSchema = z.object({
  roleId: z.number().int().positive(),
  permissionKey: z.string().min(1).max(120),
  scope: dataScopeSchema.default("all"),
});

export const revokeRolePermissionSchema = z.object({
  roleId: z.number().int().positive(),
  permissionKey: z.string().min(1).max(120),
});

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  permissions: z.array(z.string().min(1).max(120)).max(300).optional(),
});

export const materializeTemplateSchema = z
  .object({ templateId: z.string().min(1).max(64) })
  .strict();

export const setRolePermissionsSchema = z.object({
  version: z.number().int().positive(),
  items: z
    .array(
      z.object({
        permissionKey: z.string().min(1).max(120),
        scope: dataScopeSchema.default("all"),
      }),
    )
    .max(500),
});

export const roleMemberSchema = z.discriminatedUnion("principalType", [
  z.object({
    principalType: z.literal("user"),
    principalId: z.string().min(1).max(255),
  }),
  z.object({
    principalType: z.literal("group"),
    principalId: z.string().uuid(),
  }),
]);

export const simulationCandidatesQuerySchema = z.object({
  page: pageNumberField,
  limit: pageSizeField(20),
  search: z.string().trim().max(100).optional(),
});

export const listRolesQuerySchema = z
  .object({
    page: pageNumberField,
    limit: z.coerce
      .number()
      .int()
      .refine((value) => [10, 20, 50, 100].includes(value), {
        message: "Limit must be 10, 20, 50, or 100",
      })
      .default(20),
    search: z.string().trim().max(100).optional(),
  })
  .strict();

export type RolePermissionsQuery = z.infer<typeof rolePermissionsQuerySchema>;
export type AssignRolePermissionInput = z.infer<typeof assignRolePermissionSchema>;
export type RevokeRolePermissionInput = z.infer<typeof revokeRolePermissionSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type MaterializeTemplateInput = z.infer<typeof materializeTemplateSchema>;
export type SetRolePermissionsInput = z.infer<typeof setRolePermissionsSchema>;
export type RoleMemberInput = z.infer<typeof roleMemberSchema>;
export type SimulationCandidatesQuery = z.infer<typeof simulationCandidatesQuerySchema>;
export type ListRolesQuery = z.infer<typeof listRolesQuerySchema>;

export interface DiscoveryPermissionEntry {
  name: string;
  resource: string;
  action: string;
  description: string;
  moduleKey: string | null;
  scopable: boolean;
}

export interface DiscoveryGrantableResult {
  grantableKeys: string[];
  assignableRanks: number[];
  allowedModules: string[] | null;
}

export interface DiscoveryTemplateEntry {
  id: string;
  name: string;
  slug: string;
  permissionCount: number;
}

export interface DiscoveryMemberEntry {
  userId: string;
  name: string | null;
  email: string;
}
