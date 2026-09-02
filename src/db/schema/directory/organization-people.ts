import {
  pgTable,
  text,
  integer,
  timestamp,
  date,
  jsonb,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations, users, organizationMembers } from "../common/auth";

export const organizationPeople = pgTable(
  "organization_people",
  {
    organizationPersonId: text("organization_person_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    organizationMembershipId: integer("organization_membership_id"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    displayName: text("display_name"),
    preferredName: text("preferred_name"),
    workEmail: text("work_email"),
    personalEmail: text("personal_email"),
    phone: text("phone"),
    whatsappNumber: text("whatsapp_number"),
    avatarUrl: text("avatar_url"),
    dateOfBirth: date("date_of_birth"),
    gender: text("gender"),
    nationality: text("nationality"),
    timezone: text("timezone"),
    languageCode: text("language_code").default("en"),
    address: jsonb("address").$type<{
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      country?: string;
      postalCode?: string;
    }>(),
    emergencyContact: jsonb("emergency_contact").$type<{
      name?: string;
      relationship?: string;
      phone?: string;
      email?: string;
    }>(),
    linkedinUrl: text("linkedin_url"),
    githubUrl: text("github_url"),
    bio: text("bio"),
    rowVersion: integer("row_version").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByMembershipId: integer("archived_by_membership_id"),
    updatedByMembershipId: integer("updated_by_membership_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_org_people_org_person").on(
      table.organizationId,
      table.organizationPersonId,
    ),
    uniqueIndex("uniq_org_people_org_user")
      .on(table.organizationId, table.userId)
      .where(sql`user_id IS NOT NULL`),
    uniqueIndex("uniq_org_people_org_membership")
      .on(table.organizationId, table.organizationMembershipId)
      .where(sql`organization_membership_id IS NOT NULL`),
    uniqueIndex("uniq_org_people_org_work_email")
      .on(table.organizationId, table.workEmail)
      .where(sql`work_email IS NOT NULL`),
    uniqueIndex("uniq_org_people_active_work_email_ci")
      .on(table.organizationId, sql`lower(${table.workEmail})`)
      .where(
        sql`${table.workEmail} IS NOT NULL AND ${table.archivedAt} IS NULL AND ${table.deletedAt} IS NULL`,
      ),
    index("idx_org_people_user").on(table.userId),
    index("idx_org_people_membership").on(table.organizationMembershipId),
    index("idx_org_people_updated_actor").on(
      table.organizationId,
      table.updatedByMembershipId,
    ),
    index("idx_org_people_archived_actor").on(
      table.organizationId,
      table.archivedByMembershipId,
    ),
    foreignKey({
      columns: [table.organizationId, table.organizationMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_org_people_org_membership",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.updatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_org_people_updated_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.archivedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_org_people_archived_actor",
    }).onDelete("restrict"),
    check("chk_org_people_row_version", sql`${table.rowVersion} > 0`),
  ],
);
