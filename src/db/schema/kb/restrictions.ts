import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { kbArticles } from "../support/kb";

export const KB_RESTRICTION_LEVELS = ["view", "edit"] as const;
export type KbRestrictionLevel = (typeof KB_RESTRICTION_LEVELS)[number];

export const kbArticleRestrictions = pgTable(
  "kb_article_restrictions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    articleId: integer("article_id").references(() => kbArticles.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: text("role"),
    team: text("team"),
    level: text("level").$type<KbRestrictionLevel>().default("view").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_article_restrictions_article").on(table.articleId),
    index("idx_kb_article_restrictions_user").on(table.userId),
  ],
);

export const kbArticleRestrictionsRelations = relations(kbArticleRestrictions, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleRestrictions.articleId], references: [kbArticles.id] }),
  user: one(users, { fields: [kbArticleRestrictions.userId], references: [users.id] }),
}));
