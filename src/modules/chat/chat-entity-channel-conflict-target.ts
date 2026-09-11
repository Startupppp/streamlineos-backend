import { sql } from "drizzle-orm";
import { chatChannels } from "../../db/schema";

/**
 * The ON CONFLICT arbiter for `uniq_chat_channels_org_entity`, written down once.
 *
 * The index is PARTIAL — `WHERE entity_type IS NOT NULL`, migration 1058 — so a bare
 * `target: [orgId, entityType, entityId]` cannot be inferred and Postgres raises SQLSTATE
 * 42P10 at PLAN time: no colliding row and no concurrency required, the route simply 500s
 * for every caller. That is exactly the defect `uniq_chat_messages_client_key` had
 * (chat-message-conflict-target.ts) and `uniq_chat_presence_org_membership` had after it,
 * so the predicate is supplied here rather than discovered a third time in production.
 *
 * ⚠ drizzle-orm 0.45.2 reads a DIFFERENT key on each builder: `onConflictDoNothing` takes
 * `where`, `onConflictDoUpdate` takes `targetWhere`. Passing the wrong one is silently
 * dropped and re-emits the broken SQL, so this constant is shaped for
 * `onConflictDoNothing` and must not be handed to `onConflictDoUpdate` unrenamed.
 */
export const CHAT_ENTITY_CHANNEL_CONFLICT = {
  target: [chatChannels.orgId, chatChannels.entityType, chatChannels.entityId],
  where: sql`${chatChannels.entityType} is not null`,
};
