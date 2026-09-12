import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

/**
 * The audit feed's page.
 *
 * Not `cursorPageSchema`: this route spreads `page.pagination` onto the body
 * beside `items` rather than nesting it under `pagination`, and declaring the
 * nested envelope here would describe a body no caller ever receives.
 *
 * `actorName` comes from a LEFT JOIN onto `users`, so it is null both for a
 * system-written event and for an actor whose account is gone. `cursorAt` is
 * stripped before the row leaves the service — it is the keyset, not data.
 */
const auditEventSchema = z.object({
  id: z.number().int(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  createdAt: wireDate(),
});

export const listAuditEventsResponseSchema = z.object({
  items: z.array(auditEventSchema),
  limit: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
