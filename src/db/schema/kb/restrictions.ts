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
import { organizations, organizationMembers } from "../common/auth";
import { kbPages } from "./pages";

export const KB_RESTRICTION_LEVELS = ["view", "edit"] as const;
export type KbRestrictionLevel = (typeof KB_RESTRICTION_LEVELS)[number];

export const kbPageRestrictions = pgTable(
  "kb_page_restrictions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    pageId: integer("page_id").notNull(),
    membershipId: integer("membership_id"),
    role: text("role"),
    team: text("team"),
    level: text("level").$type<KbRestrictionLevel>().default("view").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_kb_page_restrictions_page").on(table.pageId),
    index("idx_kb_page_restrictions_org_membership").on(table.orgId, table.membershipId),
    index("idx_kb_page_restrictions_org_page").on(table.orgId, table.pageId),
    unique("uniq_kb_page_restrictions_org_id").on(table.orgId, table.id),
    foreignKey({ columns: [table.orgId, table.pageId], foreignColumns: [kbPages.orgId, kbPages.id], name: "fk_kb_page_restrictions_org_page" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_page_restrictions_org_membership" }).onDelete("cascade"),
  ],
);

export const kbPageRestrictionsRelations = relations(kbPageRestrictions, ({ one }) => ({
  page: one(kbPages, { fields: [kbPageRestrictions.pageId], references: [kbPages.id] }),
  membership: one(organizationMembers, { fields: [kbPageRestrictions.membershipId], references: [organizationMembers.id] }),
}));
