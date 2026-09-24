import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { kbPages } from "./pages";

export const kbPageFeedback = pgTable(
  "kb_page_feedback",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").notNull(),
    helpful: boolean("helpful").notNull(),
    comment: text("comment"),
    visitorId: text("visitor_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_page_feedback_page").on(table.pageId),
    uniqueIndex("uniq_kb_page_feedback_org_page_visitor").on(table.orgId, table.pageId, table.visitorId),
    unique("uniq_kb_page_feedback_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.pageId],
      foreignColumns: [kbPages.orgId, kbPages.id],
      name: "fk_kb_page_feedback_org_page",
    }).onDelete("cascade"),
  ],
);

export const kbPageFeedbackRelations = relations(kbPageFeedback, ({ one }) => ({
  page: one(kbPages, { fields: [kbPageFeedback.pageId], references: [kbPages.id] }),
}));
