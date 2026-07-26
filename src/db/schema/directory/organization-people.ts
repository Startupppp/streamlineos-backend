import {
  pgTable,
  text,
  integer,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations, users, organizationMembers } from "../auth";

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
    organizationMembershipId: integer("organization_membership_id").references(
      () => organizationMembers.id,
      { onDelete: "set null" },
    ),
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
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_org_people_org_person").on(
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
    index("idx_org_people_org").on(table.organizationId),
    index("idx_org_people_user").on(table.userId),
    index("idx_org_people_membership").on(table.organizationMembershipId),
  ],
);
