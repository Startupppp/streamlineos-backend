import { text, integer, foreignKey, timestamp, unique, uniqueIndex, index } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { organizations, organizationMembers } from "../common/auth";
import { tickets } from "./tasks";

export const commentDrafts = build.table("comment_drafts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  membershipId: integer("membership_id").notNull(),
  ticketId: integer("ticket_id").notNull(),
  body: text("body").notNull(),
  evidence: text("evidence"),
  proposedChange: text("proposed_change"),
  impact: text("impact"),
  confidence: integer("confidence"),
  affectedRecordIds: text("affected_record_ids"),
  retryCount: integer("retry_count"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_comment_drafts_org_ticket" }).onDelete("cascade"),
  uniqueIndex("uniq_comment_drafts_owner_ticket").on(table.orgId, table.membershipId, table.ticketId),
  index("idx_comment_drafts_ticket").on(table.ticketId),
  unique("uniq_comment_drafts_org_id").on(table.orgId, table.id),
  foreignKey({
    name: "fk_comment_drafts_actor",
    columns: [table.orgId, table.membershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
  }).onDelete("cascade"),
]);
