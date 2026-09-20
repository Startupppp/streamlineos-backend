import { foreignKey, index, integer, text, timestamp, unique } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { projects } from "./core";

export const projectAttachments = build.table(
  "project_attachments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id").notNull(),
    uploadedByMembershipId: integer("uploaded_by_membership_id").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: "fk_project_attachments_org_project",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.uploadedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_project_attachments_org_uploader",
    }).onDelete("restrict"),
    index("idx_project_attachments_org_project_cursor")
      .on(t.orgId, t.projectId, t.createdAt.desc(), t.id.desc())
      .where(sql`deleted_at IS NULL`),
    unique("uniq_project_attachments_org_id").on(t.orgId, t.id),
  ],
);
