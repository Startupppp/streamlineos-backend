import { z } from "zod";

/**
 * Response contract for `UserModuleAccessController` handlers.
 *
 * `UserModuleAccessService.getUserModuleAccess` returns an array of
 * `{ moduleKey, enabled }` items for every administrable module.
 * `setUserModuleAccess` re-fetches and returns the same list after applying
 * the change, so both handlers share the same schema.
 *
 * NOT `.strict()`: extra response fields are backward-compatible.
 */

/** A single module access entry. */
export const userModuleAccessItemSchema = z.object({
  moduleKey: z.string(),
  enabled: z.boolean(),
});

/** `UserModuleAccessService.getUserModuleAccess` / `setUserModuleAccess` */
export const userModuleAccessResponseSchema = z.array(userModuleAccessItemSchema);
