import { pgTable, serial, text, timestamp, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./auth";
import { users } from "./auth";

export const agentTokens = pgTable("agent_tokens", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_agent_tokens_hash").on(table.tokenHash),
  index("idx_agent_tokens_org_user").on(table.orgId, table.userId),
  unique("uniq_agent_tokens_org_id").on(table.orgId, table.id),
]);
