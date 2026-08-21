import { z } from "zod";

export const dataScopeSchema = z.enum(["all", "team", "own", "none"]);

export const setUserPermissionGrantsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            permissionKey: z.string().min(1).max(200),
            scope: dataScopeSchema.default("all"),
          })
          .strict(),
      )
      .max(200),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type SetUserPermissionGrantsInput = z.infer<
  typeof setUserPermissionGrantsSchema
>;
