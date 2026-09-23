import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { kbPages } from "./pages";

export const KB_PAGE_GRANT_ACCESS = [
  "view",
  "comment",
  "edit",
  "manage",
] as const;
export type KbPageGrantAccess = (typeof KB_PAGE_GRANT_ACCESS)[number];

export const kbPageGrants = pgTable(
  "kb_page_grants",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    pageId: integer("page_id").notNull(),
    membershipId: integer("membership_id"),
    role: text("role"),
    access: text("access").$type<KbPageGrantAccess>().default("view").notNull(),
    grantedByMembershipId: integer("granted_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    unique("uniq_kb_page_grants_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_kb_page_grants_live_membership")
      .on(table.orgId, table.pageId, table.membershipId)
      .where(
        sql`${table.revokedAt} IS NULL AND ${table.membershipId} IS NOT NULL`,
      ),
    uniqueIndex("uniq_kb_page_grants_live_role")
      .on(table.orgId, table.pageId, table.role)
      .where(sql`${table.revokedAt} IS NULL AND ${table.role} IS NOT NULL`),
    index("idx_kb_page_grants_org_membership_live")
      .on(table.orgId, table.membershipId, table.revokedAt, table.pageId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("idx_kb_page_grants_org_role_live")
      .on(table.orgId, table.role, table.revokedAt, table.pageId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("idx_kb_page_grants_org_page_live")
      .on(table.orgId, table.pageId, table.revokedAt)
      .where(sql`${table.revokedAt} IS NULL`),
    index("idx_kb_page_grants_org_granted_by").on(
      table.orgId,
      table.grantedByMembershipId,
    ),
    foreignKey({
      columns: [table.orgId, table.pageId],
      foreignColumns: [kbPages.orgId, kbPages.id],
      name: "fk_kb_page_grants_org_page",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_page_grants_org_membership",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.grantedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_page_grants_org_granted_by_membership",
    }).onDelete("set null"),
  ],
);

export const kbPageGrantsRelations = relations(kbPageGrants, ({ one }) => ({
  page: one(kbPages, {
    fields: [kbPageGrants.pageId],
    references: [kbPages.id],
  }),
  membership: one(organizationMembers, {
    fields: [kbPageGrants.membershipId],
    references: [organizationMembers.id],
  }),
}));
