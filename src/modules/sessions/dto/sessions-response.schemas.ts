import { z } from "zod";
import { wireDate } from "../../../common/openapi/wire-types";

/**
 * Response contract for `SessionsController` handlers.
 *
 * `SessionsService.list` hydrates the raw `user_sessions` row with
 * `withClientInfo` (parse-user-agent.ts), appending `browser`, `os`,
 * `platform`, and `isCurrent`.
 *
 * NOT `.strict()`: added fields are backward-compatible; removed/retyped
 * fields are what these schemas exist to catch.
 */

/** A single parsed session entry — `SessionsService.list`. */
export const sessionItemSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  lastActive: wireDate(),
  createdAt: wireDate(),
  browser: z.string(),
  os: z.string().nullable(),
  platform: z.string().nullable(),
  isCurrent: z.boolean(),
});

/** `SessionsService.list` — all active sessions for the caller. */
export const sessionListResponseSchema = z.array(sessionItemSchema);

/** `SessionsService.revokeOne` */
export const sessionRevokeOneResponseSchema = z.object({
  success: z.literal(true),
});

/** `SessionsService.revokeAllOthers` */
export const sessionRevokeAllResponseSchema = z.object({
  revokedCount: z.number().int(),
});
