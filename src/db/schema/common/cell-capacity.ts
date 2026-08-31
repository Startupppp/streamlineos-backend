import {
  bigint,
  doublePrecision,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const CEILING_SOURCES = [
  "measured",
  "vendor-declared",
  "operational-judgment",
] as const;
export type CeilingSource = (typeof CEILING_SOURCES)[number];
export const ceilingSourceEnum = pgEnum("cell_ceiling_source", CEILING_SOURCES);

/**
 * The history a saturation forecast is computed from, and the number admission
 * consults. One row per measurement run per cell; never overwritten, because a
 * single point cannot produce a trend and a cell that is cheap because it is
 * empty is not a finding.
 */
export const cellCapacityMeasurements = pgTable(
  "cell_capacity_measurements",
  {
    measurementId: bigint("measurement_id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    cellId: text("cell_id").notNull(),
    limitingResource: text("limiting_resource").notNull(),
    used: doublePrecision("used").notNull(),
    limitValue: doublePrecision("limit_value").notNull(),
    perOrgCost: doublePrecision("per_org_cost").notNull(),
    ceilingSource: ceilingSourceEnum("ceiling_source").notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_cell_capacity_measurements_cell").on(table.cellId, table.measuredAt),
  ],
);
