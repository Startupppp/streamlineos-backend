import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp, jsonb, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../common/auth";

/**
 * The thing a business transacts.
 *
 * Generic CRMs model people, companies and money, and have nowhere to put the
 * property, the candidate, the shipment or the policy. Every industry then bends
 * Contacts into a shape they are not, which is why one horizontal CRM never
 * feels finished for anybody.
 *
 * A tenant declares a subject TYPE and gets a real entity, without a migration.
 */

export type SubjectFieldKind =
  | "text"
  | "email"
  | "phone"
  | "url"
  | "number"
  | "money"
  | "date"
  | "select"
  | "badge"
  | "longText";

export interface SubjectFieldOption {
  value: string;
  label: string;
  /** Maps onto the status tokens; never a raw colour. */
  tone?: "success" | "warning" | "danger" | "info" | "neutral";
}

/**
 * Mirrors the renderer's `FieldSpec` deliberately.
 *
 * A tenant's declaration is the same shape the layout engine reads, so a subject
 * type becomes a rendered surface with no translation layer in between — which
 * is the whole reason the renderer takes its layout as data.
 */
export interface SubjectFieldDefinition {
  name: string;
  label: string;
  kind: SubjectFieldKind;
  required?: boolean;
  options?: SubjectFieldOption[];
  hint?: string;
}

export const subjectTypes = pgTable(
  "subject_types",
  {
    subjectTypeId: text("subject_type_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    /** Stable slug the tenant's own integrations address this type by. */
    key: text("key").notNull(),
    singular: text("singular").notNull(),
    plural: text("plural").notNull(),
    /** Which declared field is the record's title. */
    titleField: text("title_field").notNull(),
    fields: jsonb("fields").$type<SubjectFieldDefinition[]>().notNull(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Tenant-scoped, not global: two organisations may both call a type "property".
    uniqueIndex("uniq_subject_types_org_key")
      .on(t.organizationId, t.key)
      .where(sql`deleted_at is null`),
    index("idx_subject_types_org").on(t.organizationId, t.createdAt),
    // The tenant key a subject's composite foreign key points at.
    unique("uniq_subject_types_org_id").on(t.organizationId, t.subjectTypeId),
  ],
);

export const subjects = pgTable(
  "subjects",
  {
    subjectId: text("subject_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    subjectTypeId: text("subject_type_id").notNull(),
    /**
     * Denormalised from the type's `titleField`.
     *
     * A list has to sort and search on a title without reaching into JSONB for
     * every row, and the field it comes from differs per type.
     */
    title: text("title").notNull(),
    /** The tenant's own reference — a listing code, a requisition number. */
    reference: text("reference"),
    status: text("status"),
    /** Values for the type's declared fields. */
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>(),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uniq_subjects_org_type_reference")
      .on(t.organizationId, t.subjectTypeId, t.reference)
      .where(sql`reference is not null and deleted_at is null`),
    // The list read: one type, newest first. Leading organization_id because the
    // policy predicate is not leakproof and the planner needs it in the index.
    index("idx_subjects_org_type_created")
      .on(t.organizationId, t.subjectTypeId, t.createdAt, t.subjectId)
      .where(sql`deleted_at is null`),
    index("idx_subjects_org_title").on(t.organizationId, t.title).where(sql`deleted_at is null`),
    // The tenant key a link's composite foreign key points at.
    unique("uniq_subjects_org_id").on(t.organizationId, t.subjectId),
  ],
);

/**
 * How a party relates to a subject.
 *
 * A dedicated link table, not an `entity_type` + `entity_id` pair — that pattern
 * is banned for new tables because it carries no referential integrity, no
 * cascade, and defeats the composite tenant key. `relationship` is what lets one
 * property have a vendor and a buyer, or one candidate an employer and an agency.
 */
export const subjectPartyLinks = pgTable(
  "subject_party_links",
  {
    subjectPartyLinkId: text("subject_party_link_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    subjectId: text("subject_id").notNull(),
    partyId: text("party_id").notNull(),
    /** OWNER · BUYER · CANDIDATE · EMPLOYER · SHIPPER · whatever the tenant uses. */
    relationship: text("relationship").notNull(),
    linkedAt: timestamp("linked_at").defaultNow().notNull(),
    linkedBy: text("linked_by"),
  },
  (t) => [
    uniqueIndex("uniq_subject_party_link").on(
      t.organizationId,
      t.subjectId,
      t.partyId,
      t.relationship,
    ),
    // Both directions are read: a subject's parties, and a party's subjects.
    index("idx_subject_party_links_by_party").on(t.organizationId, t.partyId, t.subjectId),
  ],
);
