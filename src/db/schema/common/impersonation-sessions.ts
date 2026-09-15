import { pgTable, text, timestamp, boolean, uuid } from "drizzle-orm/pg-core";

export const impersonationSessions = pgTable("impersonation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  targetUserId: text("target_user_id").notNull(),
  sessionId: text("session_id").notNull().unique(),
  originalSessionId: text("original_session_id").notNull(),
  isRevoked: boolean("is_revoked").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});
