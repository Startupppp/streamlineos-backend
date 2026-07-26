import { z } from "zod";

const dataScopeSchema = z.enum(["all", "team", "own", "none"]);

export const moduleKeyParamSchema = z.object({
  moduleKey: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/),
});

export const moduleRoleParamSchema = z.object({
  moduleKey: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/),
  roleId: z.coerce.number().int().positive(),
});

export const setModuleRolePermissionsSchema = z.object({
  items: z
    .array(
      z.object({
        permissionKey: z.string().min(1).max(120),
        scope: dataScopeSchema.default("all"),
      }),
    )
    .max(300),
});

export type ModuleKeyParam = z.infer<typeof moduleKeyParamSchema>;
export type ModuleRoleParam = z.infer<typeof moduleRoleParamSchema>;
export type SetModuleRolePermissionsInput = z.infer<
  typeof setModuleRolePermissionsSchema
>;
