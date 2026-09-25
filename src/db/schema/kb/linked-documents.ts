import { pgTable, serial, text, integer, timestamp, index, uniqueIndex, unique, check, foreignKey } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { documents } from "../hr/documents";
import { kbSpaces } from "./spaces";

export const KB_LINKED_DOCUMENT_STATUSES = ["active", "unpublished", "source_removed"] as const;
export type KbLinkedDocumentStatus = (typeof KB_LINKED_DOCUMENT_STATUSES)[number];
export const KB_LINKED_DOCUMENT_VERSION_MODES = ["FOLLOW_LATEST", "PINNED"] as const;
export type KbLinkedDocumentVersionMode = (typeof KB_LINKED_DOCUMENT_VERSION_MODES)[number];
export const DOCUMENT_AUDIENCE_KINDS = ["ALL_EMPLOYEES", "DEPARTMENT", "LOCATION"] as const;
export type DocumentAudienceKind = (typeof DOCUMENT_AUDIENCE_KINDS)[number];

export const kbLinkedDocuments = pgTable(
  "kb_linked_documents",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    documentId: integer("document_id"),
    versionMode: text("version_mode").$type<KbLinkedDocumentVersionMode>().notNull().default("FOLLOW_LATEST"),
    pinnedVersion: integer("pinned_version"),
    status: text("status").$type<KbLinkedDocumentStatus>().notNull().default("active"),
    spaceId: integer("space_id"),
    publishedByMembershipId: integer("published_by_membership_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
    unpublishedByMembershipId: integer("unpublished_by_membership_id"),
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
    unpublishReason: text("unpublish_reason"),
    sourceRemovedAt: timestamp("source_removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_kb_linked_documents_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_kb_linked_documents_active_document")
      .on(table.orgId, table.documentId)
      .where(sql`${table.status} = 'active' AND ${table.documentId} IS NOT NULL`),
    index("idx_kb_linked_documents_org_status_published").on(table.orgId, table.status, table.publishedAt.desc(), table.id.desc()),
    index("idx_kb_linked_documents_org_document").on(table.orgId, table.documentId),
    index("idx_kb_linked_documents_org_space").on(table.orgId, table.spaceId),
    index("idx_kb_linked_documents_org_published_by").on(table.orgId, table.publishedByMembershipId),
    index("idx_kb_linked_documents_org_unpublished_by").on(table.orgId, table.unpublishedByMembershipId),
    check("chk_kb_linked_documents_version_mode", sql`${table.versionMode} IN ('FOLLOW_LATEST', 'PINNED')`),
    check("chk_kb_linked_documents_pin", sql`(${table.versionMode} = 'PINNED') = (${table.pinnedVersion} IS NOT NULL)`),
    check("chk_kb_linked_documents_pin_positive", sql`${table.pinnedVersion} IS NULL OR ${table.pinnedVersion} >= 1`),
    check("chk_kb_linked_documents_status", sql`${table.status} IN ('active', 'unpublished', 'source_removed')`),
    check("chk_kb_linked_documents_unpublished_stamped", sql`${table.status} = 'active' OR ${table.unpublishedAt} IS NOT NULL`),
    check("chk_kb_linked_documents_removed_stamped", sql`${table.status} <> 'source_removed' OR ${table.sourceRemovedAt} IS NOT NULL`),
    foreignKey({ columns: [table.orgId, table.documentId], foreignColumns: [documents.orgId, documents.id], name: "fk_kb_linked_documents_document_id_org" }).onDelete("set null"),
    foreignKey({ columns: [table.orgId, table.spaceId], foreignColumns: [kbSpaces.orgId, kbSpaces.id], name: "fk_kb_linked_documents_space_id_org" }).onDelete("set null"),
    foreignKey({ columns: [table.orgId, table.publishedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_linked_documents_published_by_actor" }).onDelete("set null"),
    foreignKey({ columns: [table.orgId, table.unpublishedByMembershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_kb_linked_documents_unpublished_by_actor" }).onDelete("set null"),
  ],
);

export const kbLinkedDocumentAudiences = pgTable(
  "kb_linked_document_audiences",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    linkedDocumentId: integer("linked_document_id").notNull(),
    kind: text("kind").$type<DocumentAudienceKind>().notNull(),
    refId: text("ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("uniq_kb_linked_document_audiences_org_id").on(table.orgId, table.id),
    uniqueIndex("uniq_kb_linked_document_audiences_member").on(table.orgId, table.linkedDocumentId, table.kind, sql`(coalesce(${table.refId}, ''))`),
    index("idx_kb_linked_document_audiences_org_kind_ref").on(table.orgId, table.kind, table.refId),
    check("chk_kb_linked_document_audiences_kind", sql`${table.kind} IN ('ALL_EMPLOYEES', 'DEPARTMENT', 'LOCATION')`),
    check("chk_kb_linked_document_audiences_ref", sql`(${table.kind} = 'ALL_EMPLOYEES') = (${table.refId} IS NULL)`),
    foreignKey({ columns: [table.orgId, table.linkedDocumentId], foreignColumns: [kbLinkedDocuments.orgId, kbLinkedDocuments.id], name: "fk_kb_linked_document_audiences_link_org" }).onDelete("cascade"),
  ],
);

export const kbLinkedDocumentsRelations = relations(kbLinkedDocuments, ({ many }) => ({
  audiences: many(kbLinkedDocumentAudiences),
}));

export const kbLinkedDocumentAudiencesRelations = relations(kbLinkedDocumentAudiences, ({ one }) => ({
  link: one(kbLinkedDocuments, { fields: [kbLinkedDocumentAudiences.linkedDocumentId], references: [kbLinkedDocuments.id] }),
}));
