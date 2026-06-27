import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export interface OrgOverride {
  orgId: string;
  enabled: boolean;
}

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull().default("global"),
    enabled: boolean("enabled").default(false).notNull(),
    rolloutPercentage: integer("rollout_percentage").default(0).notNull(),
    orgOverrides: jsonb("org_overrides").$type<OrgOverride[]>().default([]).notNull(),
    expiresAt: timestamp("expires_at"),
    isArchived: boolean("is_archived").default(false).notNull(),
    createdById: text("created_by").references(() => users.id),
    updatedById: text("updated_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_feature_flags_key").on(table.key),
    index("idx_feature_flags_enabled").on(table.enabled, table.isArchived),
  ],
);
