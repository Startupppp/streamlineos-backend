import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { kbPages } from "./pages";
import { kbTranslationStatusEnum } from "../common/enums";

export const kbPageTranslations = pgTable(
  "kb_page_translations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").notNull(),
    locale: text("locale").notNull(),
    title: text("title").notNull(),
    content: text("content").default("").notNull(),
    contentText: text("content_text").default("").notNull(),
    excerpt: text("excerpt"),
    status: kbTranslationStatusEnum("status").default("draft").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_kb_page_translations").on(table.pageId, table.locale),
    index("idx_kb_page_translations_org_page").on(table.orgId, table.pageId),
    unique("uniq_kb_page_translations_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.pageId], foreignColumns: [kbPages.orgId, kbPages.id], name: "fk_kb_page_translations_org_page" }).onDelete("cascade"),
  ],
);

export const kbPageTranslationsRelations = relations(kbPageTranslations, ({ one }) => ({
  page: one(kbPages, { fields: [kbPageTranslations.pageId], references: [kbPages.id] }),
}));
