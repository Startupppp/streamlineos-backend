import { z } from "zod";

export const scopeDirectoryKeySchema = z
  .string()
  .regex(
    /^(workspace:[^:\s]+|product:[0-9]+|project:[0-9]+)$/,
    "key must be workspace:<pmWorkspaceId>, product:<numericId> or project:<numericId>",
  );

export const resolveScopeDirectorySchema = z
  .object({
    keys: z.array(scopeDirectoryKeySchema).min(1).max(26),
  })
  .strict();

export type ResolveScopeDirectoryInput = z.infer<typeof resolveScopeDirectorySchema>;

export const scopeDirectoryRefSchema = z
  .object({
    key: z.string(),
    type: z.enum(["workspace", "product", "project"]),
    id: z.string(),
    name: z.string(),
    parentKey: z.string().nullable(),
    projectKey: z.string().nullable(),
    isArchived: z.boolean(),
    parentPath: z.string().nullable(),
    clientPortalEnabled: z.boolean().nullable(),
  })
  .strict();

export type ScopeDirectoryRef = z.infer<typeof scopeDirectoryRefSchema>;

export const scopeDirectoryResponseSchema = z
  .object({
    data: z.array(scopeDirectoryRefSchema),
  })
  .strict();
