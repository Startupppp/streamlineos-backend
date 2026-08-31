import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const NOISY_NEIGHBOUR_ACTIONS = ["THROTTLING_REVIEW", "RELOCATION"] as const;
export type NoisyNeighbourAction = (typeof NOISY_NEIGHBOUR_ACTIONS)[number];
export const noisyNeighbourActionEnum = pgEnum("noisy_neighbour_action", NOISY_NEIGHBOUR_ACTIONS);

export const TENANT_CLASSES = ["SHARED", "DEDICATED"] as const;
export type TenantClassValue = (typeof TENANT_CLASSES)[number];
export const tenantClassEnum = pgEnum("tenant_class", TENANT_CLASSES);

interface StoredRejection {
  cellId: string;
  code: string;
}

/**
 * No foreign key to `organizations`: placement is reserved before the cell's
 * organisation row exists, and once the control plane and the cell are separate
 * databases the constraint cannot exist at all.
 */
export const placementDecisions = pgTable(
  "placement_decisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    region: text("region").notNull(),
    tenantClass: tenantClassEnum("tenant_class").notNull(),
    admitted: boolean("admitted").notNull(),
    selectedCellId: text("selected_cell_id"),
    rejections: jsonb("rejections").$type<StoredRejection[]>().notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_placement_decisions_org").on(table.organizationId, table.decidedAt),
    index("idx_placement_decisions_cell").on(table.selectedCellId, table.decidedAt),
  ],
);

/**
 * No foreign key to `organizations`: see `placementDecisions` above.
 */
export const noisyNeighbourReviews = pgTable(
  "noisy_neighbour_reviews",
  {
    id: text("id").primaryKey(),
    cellId: text("cell_id").notNull(),
    organizationId: text("organization_id").notNull(),
    shareRatio: doublePrecision("share_ratio").notNull(),
    consecutiveWindows: integer("consecutive_windows").notNull(),
    action: noisyNeighbourActionEnum("action").notNull(),
    outcome: text("outcome"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_noisy_neighbour_reviews_org").on(table.organizationId, table.createdAt),
    index("idx_noisy_neighbour_reviews_cell").on(table.cellId, table.createdAt),
    index("idx_noisy_neighbour_reviews_unresolved")
      .on(table.cellId, table.createdAt)
      .where(sql`resolved_at IS NULL`),
  ],
);
