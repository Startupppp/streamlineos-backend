import { z } from "zod";
import { dataScopeSchema } from "./rbac.schemas";

export const permissionKeySchema = z.string().min(1).max(120);
export const moduleKeySchema = z.string().min(1).max(80);

export const permissionResponseSchema = z
  .object({
    name: permissionKeySchema,
    resource: z.string().min(1).max(120),
    action: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    scopable: z.boolean().optional(),
    baselineScope: z.enum(["own", "all"]).optional(),
  })
  .strict();

export const permissionCatalogResponseSchema = z
  .array(permissionResponseSchema)
  .max(2_000);

export const rolePermissionMutationResponseSchema = z
  .object({ success: z.literal(true) })
  .strict();

export const accessSnapshotResponseSchema = z
  .object({
    scopes: z.record(permissionKeySchema, dataScopeSchema),
    modules: z.record(moduleKeySchema, z.boolean()),
    isOrgOwner: z.boolean(),
    canManageOrganizationMembership: z.boolean(),
    mfa: z.object({ enforced: z.boolean(), satisfied: z.boolean() }).strict(),
    version: z.number().int().nonnegative(),
  })
  .strict();

export const discoveryPermissionsResponseSchema = z
  .array(
    z
      .object({
        name: permissionKeySchema,
        resource: z.string().min(1).max(120),
        action: z.string().min(1).max(80),
        description: z.string().min(1).max(500),
        moduleKey: moduleKeySchema.nullable(),
        scopable: z.boolean(),
      })
      .strict(),
  )
  .max(2_000);

export const discoveryGrantableResponseSchema = z
  .object({
    grantableKeys: z.array(permissionKeySchema).max(2_000),
    assignableRanks: z.array(z.number().int()).max(20),
    allowedModules: z.array(moduleKeySchema).max(100).nullable(),
  })
  .strict();

export const discoveryTemplatesResponseSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(100),
        slug: z.string().min(1).max(100),
        permissionCount: z.number().int().nonnegative(),
      })
      .strict(),
  )
  .max(100);

export const discoveryMembersResponseSchema = z
  .array(
    z
      .object({
        userId: z.string().min(1).max(255),
        name: z.string().max(255).nullable(),
        email: z.string().email().max(320),
      })
      .strict(),
  )
  .max(500);

export type DiscoveryPermissionEntry = z.infer<
  typeof discoveryPermissionsResponseSchema
>[number];
export type DiscoveryGrantableResult = z.infer<
  typeof discoveryGrantableResponseSchema
>;
export type DiscoveryTemplateEntry = z.infer<
  typeof discoveryTemplatesResponseSchema
>[number];
export type DiscoveryMemberEntry = z.infer<
  typeof discoveryMembersResponseSchema
>[number];
