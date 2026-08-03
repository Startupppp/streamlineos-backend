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
    .max(200),
  expiresAt: z.coerce.date().optional(),
});

export type CreateUserApiTokenInput = z.infer<typeof createUserApiTokenSchema>;
