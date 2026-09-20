import { foreignKey, index, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { projects } from "./core";

export const projectUpdates = build.table(
  "project_updates",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id").notNull(),
    authorMembershipId: integer("author_membership_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: "fk_project_updates_org_project",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.authorMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_project_updates_org_author",
    }).onDelete("restrict"),
    index("idx_project_updates_org_project_cursor")
      .on(t.orgId, t.projectId, t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL`),
    unique("uniq_project_updates_org_id").on(t.orgId, t.id),
  ],
);
