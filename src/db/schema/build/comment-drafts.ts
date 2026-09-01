import { text, integer, foreignKey, timestamp, unique, uniqueIndex, index } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { organizations, users, organizationMembers } from "../common/auth";
import { tickets } from "./tasks";

export const commentDrafts = build.table("comment_drafts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  membershipId: integer("membership_id"),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("uniq_comment_drafts_owner_ticket").on(table.orgId, table.userId, table.ticketId),
  index("idx_comment_drafts_org_user").on(table.orgId, table.userId),
  index("idx_comment_drafts_org_member_membership").on(table.orgId, table.membershipId),
  index("idx_comment_drafts_ticket").on(table.ticketId),
  unique("uniq_comment_drafts_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_comment_drafts_actor",
    columns: [table.orgId, table.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);
