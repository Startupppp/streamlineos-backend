import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { ORGANIZATION_PLACEMENT_STATUSES } from "../../../common/region/placement";

export const organizationPlacementStatusEnum = pgEnum(
  "organization_placement_status",
  ORGANIZATION_PLACEMENT_STATUSES,
);

/**
 * No foreign key to `organizations`: placement is reserved before the cell's
 * organisation row exists, and once the control plane and the cell are separate
 * databases the constraint cannot exist at all. Removal is explicit, through
 * `unplaceOrganization`.
 */
export const organizationPlacement = pgTable(
  "organization_placement",
  {
    organizationId: text("organization_id").primaryKey(),
    region: text("region").notNull(),
    cellId: text("cell_id").notNull(),
    databaseShard: text("database_shard").notNull(),
    objectStorageRegion: text("object_storage_region").notNull(),
    searchCluster: text("search_cluster").notNull(),
    placementVersion: integer("placement_version").default(1).notNull(),
    writeFenceToken: text("write_fence_token").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    status: organizationPlacementStatusEnum("status")
      .default("ACTIVE")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_organization_placement_cell").on(table.cellId, table.status),
    index("idx_organization_placement_region").on(table.region),
    index("idx_organization_placement_lease").on(table.leaseExpiresAt),
  ],
);
