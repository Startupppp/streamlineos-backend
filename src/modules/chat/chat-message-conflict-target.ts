import { sql, type SQL } from "drizzle-orm";
import type { IndexColumn } from "drizzle-orm/pg-core";
import { chatMessages } from "../../db/schema";

/**
 * `uniq_chat_messages_client_key` is PARTIAL (`WHERE client_key IS NOT NULL`, migration
 * 0980). Postgres cannot infer a partial index from a bare column list, so a conflict
 * target without the predicate raises 42P10 at plan time and every send 500s. In
 * drizzle-orm 0.45.2 the arbiter predicate for `onConflictDoNothing` is `where`, not the
 * `targetWhere` that `onConflictDoUpdate` takes; the annotation below makes a wrong key a
 * compile error. Exported so the regression spec drives the real value, not a copy.
 */
export const CHAT_MESSAGE_CLIENT_KEY_CONFLICT: { target: IndexColumn[]; where: SQL } = {
  target: [chatMessages.orgId, chatMessages.channelId, chatMessages.clientKey],
  where: sql`${chatMessages.clientKey} is not null`,
};
