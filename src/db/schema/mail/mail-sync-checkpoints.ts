import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

export const mailSyncCheckpoints = pgTable(
  "mail_sync_checkpoints",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    accountId: integer("account_id").notNull(),
    folder: text("folder").notNull(),
    cursorValue: text("cursor_value"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_mail_sync_checkpoint_account_folder").on(table.accountId, table.folder),
    unique("uniq_mail_sync_checkpoint_org_id").on(table.orgId, table.id),
  ],
);
