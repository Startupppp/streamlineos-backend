import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations, organizationMembers } from "../common/auth";
import { organizationPeople } from "./organization-people";

export const workers = pgTable(
  "workers",
  {
    workerId: text("worker_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    organizationPersonId: text("organization_person_id").notNull(),
    workerNumber: text("worker_number"),
    status: text("status")
      .$type<"ACTIVE" | "INACTIVE" | "EXITED">()
      .default("INACTIVE")
      .notNull(),
    isPayee: boolean("is_payee").default(false).notNull(),
    rowVersion: integer("row_version").default(1).notNull(),
    createdByMembershipId: integer("created_by_membership_id"),
    updatedByMembershipId: integer("updated_by_membership_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByMembershipId: integer("archived_by_membership_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_workers_org_worker").on(table.organizationId, table.workerId),
    uniqueIndex("uniq_workers_org_person").on(
      table.organizationId,
      table.organizationPersonId,
    ),
    unique("uniq_workers_org_person_worker").on(
      table.organizationId,
      table.organizationPersonId,
      table.workerId,
    ),
    uniqueIndex("uniq_workers_org_number")
      .on(table.organizationId, table.workerNumber)
      .where(sql`worker_number IS NOT NULL`),
    uniqueIndex("uniq_workers_active_org_number")
      .on(table.organizationId, table.workerNumber)
      .where(
        sql`${table.workerNumber} IS NOT NULL AND ${table.archivedAt} IS NULL AND ${table.deletedAt} IS NULL`,
      ),
    index("idx_workers_org").on(table.organizationId),
    index("idx_workers_person").on(table.organizationPersonId),
    index("idx_workers_org_status").on(table.organizationId, table.status),
    index("idx_workers_created_actor").on(
      table.organizationId,
      table.createdByMembershipId,
    ),
    index("idx_workers_updated_actor").on(
      table.organizationId,
      table.updatedByMembershipId,
    ),
    index("idx_workers_archived_actor").on(
      table.organizationId,
      table.archivedByMembershipId,
    ),
    foreignKey({
      columns: [table.organizationId, table.organizationPersonId],
      foreignColumns: [
        organizationPeople.organizationId,
        organizationPeople.organizationPersonId,
      ],
      name: "fk_workers_org_person",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_workers_created_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.updatedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_workers_updated_actor",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.organizationId, table.archivedByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_workers_archived_actor",
    }).onDelete("restrict"),
    check(
      "chk_workers_status",
      sql`${table.status} IN ('ACTIVE', 'INACTIVE', 'EXITED')`,
    ),
    check("chk_workers_row_version", sql`${table.rowVersion} > 0`),
  ],
);
