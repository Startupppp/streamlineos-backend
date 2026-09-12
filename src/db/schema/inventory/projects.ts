import { pgTable, text, timestamp, date, decimal, integer, index, uniqueIndex, unique, foreignKey, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { invProjectStatusEnum, invRequirementStatusEnum } from "../common/enums";
import { organizations, users } from "../common/auth";
import { invProductVariants } from "./core";
import { invWarehouses } from "./warehouses";

/**
 * B1 — a construction site, as inventory sees it.
 *
 * A project is a *demand source*, not a second stock location: material for a
 * site is reserved out of the dark store that will serve it and only leaves the
 * ledger when it is dispatched. That is why there is no balance column here —
 * "how much has this site had" is a question the ledger answers, and a second
 * running total would be a second answer to it.
 *
 * Reservations against a project reuse `inv_stock_reservations`, which is
 * already polymorphic on `source_type`; a project reservation is
 * `source_type = 'PROJECT_REQUIREMENT'` with the requirement id as the source.
 * A separate reservation table would fork the availability calculation, which is
 * the one number this system exists to give once.
 */
export const invProjects = pgTable("inv_projects", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  /**
   * The customer this site belongs to, when there is one. Nullable because a
   * builder's own site has no external client.
   *
   * A legacy client id. The `clients` table left the Drizzle schema with the CRM
   * Party migration, and new ids are minted in `client_party_map`, so the live
   * key (0915) is (org_id, client_id) → client_party_map, declared in SQL only.
   * Deleting a customer a project still names is refused. The old `set null`
   * nulled org_id too and never worked.
   */
  clientId: integer("client_id"),
  siteAddress: text("site_address"),
  city: text("city"),
  /**
   * Which delivery zone the site sits in. Matches `inv_warehouses.zone`, so
   * "which dark store can serve this site" is a lookup rather than a guess, and
   * no geocoder is needed to rank the stores that can cover a shortage.
   */
  zone: text("zone"),
  siteContactName: text("site_contact_name"),
  siteContactPhone: text("site_contact_phone"),
  status: invProjectStatusEnum("status").default("PLANNING").notNull(),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  unique("uniq_inv_projects_org_id").on(table.orgId, table.id),
  // Partial: a deleted project must not hold its code hostage, and the scope is
  // the tenant — a bare unique index lets one organisation's code block another's.
  uniqueIndex("uniq_inv_projects_org_code_live").on(table.orgId, table.code).where(sql`deleted_at IS NULL`),
  index("idx_inv_projects_org_status").on(table.orgId, table.status).where(sql`deleted_at IS NULL`),
  index("idx_inv_projects_org_zone").on(table.orgId, table.zone).where(sql`deleted_at IS NULL`),
  index("idx_inv_projects_client").on(table.orgId, table.clientId).where(sql`client_id IS NOT NULL`),
  index("idx_inv_projects_name_trgm").using("gin", table.name.op("gin_trgm_ops")),
]);

/**
 * B1 — one material line a site still needs.
 *
 * `fulfilledQty` is a running total written by named dispatches, never derived
 * on the fly: a reversed dispatch has to reduce it, and a sum over the ledger
 * would have to know which movements counted as "went to site" — a question the
 * ledger cannot answer without this row already saying so.
 *
 * There is no `reservedQty` column. What is reserved for this line is the sum of
 * its ACTIVE rows in `inv_stock_reservations`, and duplicating it here would let
 * the two disagree — at which point neither is trustworthy and availability is
 * wrong for everybody, not just this project.
 */
export const invProjectRequirements = pgTable("inv_project_requirements", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").notNull(),
  productVariantId: integer("product_variant_id").notNull(),
  /**
   * Which store the site expects to be served from. Nullable: "we need 200 bags
   * by Friday" is a real requirement before anybody has decided where they come
   * from, and forcing a store here would make the planner guess.
   */
  warehouseId: integer("warehouse_id"),
  requiredQty: decimal("required_qty", { precision: 18, scale: 4 }).notNull(),
  fulfilledQty: decimal("fulfilled_qty", { precision: 18, scale: 4 }).default("0").notNull(),
  requiredBy: date("required_by"),
  status: invRequirementStatusEnum("status").default("DRAFT").notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_inv_project_requirements_org_id").on(table.orgId, table.id),
  index("idx_inv_project_reqs_org_project").on(table.orgId, table.projectId, table.status),
  index("idx_inv_project_reqs_org_variant").on(table.orgId, table.productVariantId),
  // The at-risk sweep: open requirements ordered by the date they are needed.
  // Partial, so a finished project's lines never enter the scan.
  index("idx_inv_project_reqs_org_due")
    .on(table.orgId, table.requiredBy)
    .where(sql`status IN ('DRAFT', 'REQUESTED', 'RESERVED', 'PARTIALLY_FULFILLED')`),
  check("chk_inv_project_requirements_qty_positive", sql`${table.requiredQty} > 0`),
  check("chk_inv_project_requirements_fulfilled_nonneg", sql`${table.fulfilledQty} >= 0`),
  foreignKey({
    columns: [table.orgId, table.projectId],
    foreignColumns: [invProjects.orgId, invProjects.id],
    name: "fk_inv_project_reqs_org_project",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.orgId, table.productVariantId],
    foreignColumns: [invProductVariants.orgId, invProductVariants.id],
    name: "fk_inv_project_reqs_org_variant",
  }),
  // The live key carries Postgres 15's column-list form, `ON DELETE SET NULL
  // (warehouse_id)`, which drizzle-orm 0.45 cannot express; the bare keyword it
  // emits nulls org_id as well, which is NOT NULL, so the warehouse delete
  // aborted. 0915 repaired that; regenerating this from Drizzle would reinstall
  // it. `check:composite-fk-set-null` fails if it comes back.
  foreignKey({
    columns: [table.orgId, table.warehouseId],
    foreignColumns: [invWarehouses.orgId, invWarehouses.id],
    name: "fk_inv_project_reqs_org_warehouse",
  }),
]);

export const invProjectsRelations = relations(invProjects, ({ one, many }) => ({
  organization: one(organizations, { fields: [invProjects.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [invProjects.createdBy], references: [users.id], relationName: "invProjectCreator" }),
  requirements: many(invProjectRequirements),
}));

export const invProjectRequirementsRelations = relations(invProjectRequirements, ({ one }) => ({
  organization: one(organizations, { fields: [invProjectRequirements.orgId], references: [organizations.id] }),
  project: one(invProjects, { fields: [invProjectRequirements.projectId], references: [invProjects.id] }),
  productVariant: one(invProductVariants, { fields: [invProjectRequirements.productVariantId], references: [invProductVariants.id] }),
  warehouse: one(invWarehouses, { fields: [invProjectRequirements.warehouseId], references: [invWarehouses.id] }),
}));
