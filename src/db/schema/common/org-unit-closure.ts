import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { orgUnits } from "./organization";

export const orgUnitClosure = pgTable(
  "org_unit_closure",
  {
    organizationId: text("organization_id").notNull(),
    ancestorId: text("ancestor_id").notNull(),
    descendantId: text("descendant_id").notNull(),
    depth: integer("depth").notNull(),
  },
  (table) => [
    primaryKey({
      name: "pk_org_unit_closure",
      columns: [table.organizationId, table.ancestorId, table.descendantId],
    }),
    foreignKey({
      name: "fk_org_unit_closure_ancestor_tenant",
      columns: [table.organizationId, table.ancestorId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_org_unit_closure_descendant_tenant",
      columns: [table.organizationId, table.descendantId],
      foreignColumns: [orgUnits.orgId, orgUnits.id],
    }).onDelete("cascade"),
    check(
      "chk_org_unit_closure_depth",
      sql`(${table.ancestorId} = ${table.descendantId} AND ${table.depth} = 0) OR (${table.ancestorId} <> ${table.descendantId} AND ${table.depth} > 0)`,
    ),
    index("idx_org_unit_closure_descendant_scope").on(
      table.organizationId,
      table.descendantId,
      table.depth,
      table.ancestorId,
    ),
  ],
);
