import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";

export const mailMessageMetadata = pgTable(
  "mail_message_metadata",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    accountId: integer("account_id").notNull(),
    userMembershipId: integer("user_membership_id"),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    subject: text("subject").notNull().default(""),
    senderEmail: text("sender_email").notNull().default(""),
    senderName: text("sender_name"),
    date: timestamp("date", { withTimezone: true }),
    isRead: boolean("is_read").notNull().default(false),
    isStarred: boolean("is_starred").notNull().default(false),
    labels: jsonb("labels").$type<string[]>(),
    folder: text("folder").notNull().default("inbox"),
    hasAttachment: boolean("has_attachment").notNull().default(false),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_mail_metadata_account_msg").on(table.accountId, table.messageId),
    unique("uniq_mail_metadata_org_id").on(table.orgId, table.id),
    index("idx_mail_metadata_list").on(
      table.orgId,
      table.userMembershipId,
      table.folder,
      table.date.desc(),
    ),
    index("idx_mail_metadata_thread").on(table.orgId, table.userMembershipId, table.threadId),
    index("idx_mail_metadata_account_sync").on(table.accountId, table.syncedAt.desc()),
    index("idx_mail_metadata_search").on(table.orgId, table.userMembershipId, table.syncedAt.desc()),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_mail_meta_org_user_mbr",
    }).onDelete("set null"),
  ],
);
