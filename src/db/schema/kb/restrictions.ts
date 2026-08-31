import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
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
    membershipId: integer("membership_id"),
    role: text("role"),
    team: text("team"),
    level: text("level").$type<KbRestrictionLevel>().default("view").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_article_restrictions_article").on(table.articleId),
    index("idx_kb_article_restrictions_user").on(table.userId),
    index("idx_kb_article_restrictions_org_membership").on(table.orgId, table.membershipId),
    index("idx_kb_article_restrictions_org_article").on(table.orgId, table.articleId),
    unique("uniq_kb_article_restrictions_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.articleId], foreignColumns: [kbArticles.orgId, kbArticles.id], name: "fk_kb_article_restrictions_org_article" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_article_restrictions_org_membership" }).onDelete("set null"),
  ],
);

export const kbArticleRestrictionsRelations = relations(kbArticleRestrictions, ({ one }) => ({
  article: one(kbArticles, { fields: [kbArticleRestrictions.articleId], references: [kbArticles.id] }),
  user: one(users, { fields: [kbArticleRestrictions.userId], references: [users.id] }),
  membership: one(organizationMembers, { fields: [kbArticleRestrictions.membershipId], references: [organizationMembers.id] }),
}));
