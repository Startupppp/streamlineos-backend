import {
  pgTable,
  text,
  boolean,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { organizations } from "../auth";
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
    uniqueIndex("uniq_workers_org_number")
      .on(table.organizationId, table.workerNumber)
      .where(sql`worker_number IS NOT NULL`),
    index("idx_workers_org").on(table.organizationId),
    index("idx_workers_person").on(table.organizationPersonId),
    index("idx_workers_org_status").on(table.organizationId, table.status),
    foreignKey({
      columns: [table.organizationId, table.organizationPersonId],
      foreignColumns: [
        organizationPeople.organizationId,
        organizationPeople.organizationPersonId,
      ],
      name: "fk_workers_org_person",
    }).onDelete("restrict"),
  ],
);
