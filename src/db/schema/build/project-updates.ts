import { check, foreignKey, index, integer, pgEnum, text, timestamp, unique } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { projects } from "./core";

export const projectUpdateAudienceEnum = pgEnum("project_update_audience", ["internal", "client"]);
export const projectUpdateStatusEnum = pgEnum("project_update_status", ["draft", "published"]);

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
    wins: text("wins"),
    risks: text("risks"),
    next: text("next"),
    citations: text("citations"),
    audience: projectUpdateAudienceEnum("audience").notNull().default("internal"),
    status: projectUpdateStatusEnum("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
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
    index("idx_project_updates_org_project_audience_cursor")
      .on(t.orgId, t.projectId, t.audience, t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL AND status = 'published'`),
    unique("uniq_project_updates_org_id").on(t.orgId, t.id),
    check(
      "chk_project_updates_published_at",
      sql`(${t.status} = 'draft' AND ${t.publishedAt} IS NULL) OR (${t.status} = 'published' AND ${t.publishedAt} IS NOT NULL)`,
    ),
  ],
);
