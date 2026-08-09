import { z } from "zod";
import { ALL_PERMISSION_NAMES } from "../../../rbac/permissions";

const PERMISSION_KEYS: ReadonlySet<string> = new Set(ALL_PERMISSION_NAMES);

export const createUserApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(
      z
        .string()
        .min(1)
        .refine((key) => PERMISSION_KEYS.has(key), {
          message: "Unknown permission key",
        }),
    )
    .min(1, "Select at least one permission for this token")
    .max(200)
    .refine((scopes) => new Set(scopes).size === scopes.length, {
      message: "Duplicate permissions are not allowed",
    }),
  expiresAt: z.coerce
    .date()
    .refine((value) => value.getTime() > Date.now(), {
      message: "Expiration must be in the future",
    })
    .refine(
      (value) => value.getTime() <= Date.now() + 366 * 24 * 60 * 60 * 1000,
      { message: "Personal tokens cannot exceed one year" },
    ),
});

export type CreateUserApiTokenInput = z.infer<typeof createUserApiTokenSchema>;

export const listUserApiTokensSchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type ListUserApiTokensInput = z.infer<
  typeof listUserApiTokensSchema
>;
