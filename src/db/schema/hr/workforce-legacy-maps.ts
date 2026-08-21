import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizationMembers, organizations } from "../common/auth";
import { organizationPeople } from "../directory/organization-people";
import { workerEngagements } from "../directory/worker-engagements";
import { workers } from "../directory/workers";
import { hrEmployments, hrPeople } from "./core-people";

export const hrPersonLegacyMap = pgTable(
  "hr_person_legacy_map",
  {
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "restrict" })
      .notNull(),
    hrPersonId: integer("hr_person_id").notNull(),
    organizationPersonId: text("organization_person_id").notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    createdByMembershipId: integer("created_by_membership_id").notNull(),
    updatedByMembershipId: integer("updated_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.orgId, table.hrPersonId],
      name: "pk_hr_person_legacy_map",
    }),
    unique("uniq_hr_person_legacy_map_org_person").on(
      table.orgId,
      table.organizationPersonId,
    ),
    unique("uniq_hr_person_legacy_map_chain").on(
      table.orgId,
      table.hrPersonId,
      table.organizationPersonId,
    ),
    index("idx_hr_person_legacy_map_created_actor").on(
      table.orgId,
      table.createdByMembershipId,
    ),
    index("idx_hr_person_legacy_map_updated_actor").on(
      table.orgId,
      table.updatedByMembershipId,
    ),
    foreignKey({
      columns: [table.orgId, table.hrPersonId],
      foreignColumns: [hrPeople.orgId, hrPeople.id],
      name: "fk_hr_person_legacy_map_hr_person",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.organizationPersonId],
      foreignColumns: [
        organizationPeople.organizationId,
        organizationPeople.organizationPersonId,
      ],
      name: "fk_hr_person_legacy_map_org_person",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_person_legacy_map_created_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.updatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_person_legacy_map_updated_actor",
    }).onDelete("restrict"),
    check("chk_hr_person_legacy_map_row_version", sql`${table.rowVersion} > 0`),
  ],
);

export const hrEmploymentLegacyMap = pgTable(
  "hr_employment_legacy_map",
  {
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "restrict" })
      .notNull(),
    hrEmploymentId: integer("hr_employment_id").notNull(),
    hrPersonId: integer("hr_person_id").notNull(),
    organizationPersonId: text("organization_person_id").notNull(),
    workerId: text("worker_id").notNull(),
    workerEngagementId: text("worker_engagement_id").notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    createdByMembershipId: integer("created_by_membership_id").notNull(),
    updatedByMembershipId: integer("updated_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.orgId, table.hrEmploymentId],
      name: "pk_hr_employment_legacy_map",
    }),
    unique("uniq_hr_employment_legacy_map_engagement").on(
      table.orgId,
      table.workerEngagementId,
    ),
    index("idx_hr_employment_legacy_map_person").on(
      table.orgId,
      table.hrPersonId,
    ),
    index("idx_hr_employment_legacy_map_worker").on(
      table.orgId,
      table.workerId,
    ),
    index("idx_hr_employment_legacy_map_created_actor").on(
      table.orgId,
      table.createdByMembershipId,
    ),
    index("idx_hr_employment_legacy_map_updated_actor").on(
      table.orgId,
      table.updatedByMembershipId,
    ),
    foreignKey({
      columns: [table.orgId, table.hrEmploymentId, table.hrPersonId],
      foreignColumns: [hrEmployments.orgId, hrEmployments.id, hrEmployments.personId],
      name: "fk_hr_employment_legacy_map_hr_employment",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.hrPersonId, table.organizationPersonId],
      foreignColumns: [
        hrPersonLegacyMap.orgId,
        hrPersonLegacyMap.hrPersonId,
        hrPersonLegacyMap.organizationPersonId,
      ],
      name: "fk_hr_employment_legacy_map_person_map",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.organizationPersonId, table.workerId],
      foreignColumns: [
        workers.organizationId,
        workers.organizationPersonId,
        workers.workerId,
      ],
      name: "fk_hr_employment_legacy_map_worker",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.workerId, table.workerEngagementId],
      foreignColumns: [
        workerEngagements.organizationId,
        workerEngagements.workerId,
        workerEngagements.workerEngagementId,
      ],
      name: "fk_hr_employment_legacy_map_engagement",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_employment_legacy_map_created_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.orgId, table.updatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_hr_employment_legacy_map_updated_actor",
    }).onDelete("restrict"),
    check(
      "chk_hr_employment_legacy_map_row_version",
      sql`${table.rowVersion} > 0`,
    ),
  ],
);
