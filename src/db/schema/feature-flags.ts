import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export interface OrgOverride {
  orgId: string;
  enabled: boolean;
}

export type FeatureFlagType = "boolean" | "percentage";

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").$type<FeatureFlagType>().default("boolean").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    rolloutPercentage: integer("rollout_percentage").default(0).notNull(),
    orgOverrides: jsonb("org_overrides").$type<OrgOverride[]>().default([]).notNull(),
    expiresAt: timestamp("expires_at"),
    isArchived: boolean("is_archived").default(false).notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uq_feature_flags_key").on(table.key),
    index("idx_feature_flags_key").on(table.key),
    index("idx_feature_flags_archived").on(table.isArchived),
  ],
);

export type FeatureFlag = typeof featureFlags.$inferSelect;
