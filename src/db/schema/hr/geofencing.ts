import { pgTable, text, serial, timestamp, decimal, integer, boolean, index, unique } from "drizzle-orm/pg-core";
import { organizations } from "../auth";

export const geofences = pgTable("geofences", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  lat: decimal("lat", { precision: 10, scale: 7 }).notNull(),
  lng: decimal("lng", { precision: 10, scale: 7 }).notNull(),
  radiusMeters: integer("radius_meters").default(200).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_geofences_org_id").on(table.orgId, table.id),
  index("idx_geofences_org_active").on(table.orgId, table.isActive),
]);
