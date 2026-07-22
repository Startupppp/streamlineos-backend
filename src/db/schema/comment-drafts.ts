import { pgTable, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, users } from "./auth";
import { tickets } from "./projects/tasks";

export const commentDrafts = pgTable("comment_drafts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_comment_drafts_owner_ticket").on(table.orgId, table.userId, table.ticketId),
  index("idx_comment_drafts_org_user").on(table.orgId, table.userId),
  index("idx_comment_drafts_ticket").on(table.ticketId),
]);
