import { z } from "zod";

export const rolePermissionsQuerySchema = z.object({
  role: z.string().min(1).max(100),
});

export const assignRolePermissionSchema = z.object({
  role: z.string().min(1).max(100),
  permissionId: z.number().int().positive(),
});

export const createRoleSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z_]+$/),
  permissions: z.array(z.string().min(1).max(120)).max(300).default([]),
});

export const updateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  permissions: z.array(z.string().min(1).max(120)).max(300).optional(),
});

export const cloneTemplateSchema = z.object({
  templateId: z.string().min(1).max(100),
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z_]+$/)
    .optional(),
});

export const dataScopeSchema = z.enum(["all", "team", "own", "none"]);

export const setRolePermissionsSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
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
    principalType: z.literal("department"),
    principalId: z.number().int().positive(),
  }),
]);

export type RolePermissionsQuery = z.infer<typeof rolePermissionsQuerySchema>;
export type AssignRolePermissionInput = z.infer<typeof assignRolePermissionSchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type CloneTemplateInput = z.infer<typeof cloneTemplateSchema>;
export type SetRolePermissionsInput = z.infer<typeof setRolePermissionsSchema>;
export type RoleMemberInput = z.infer<typeof roleMemberSchema>;
