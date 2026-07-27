import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./auth";

export type OrgOverride = { orgId: string; enabled: boolean };

export type FlagType = "global" | "percentage" | "org" | "user";

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").$type<FlagType>().notNull().default("global"),
    enabled: boolean("enabled").notNull().default(false),
    rolloutPercentage: integer("rollout_percentage").notNull().default(0),
    orgOverrides: jsonb("org_overrides").$type<OrgOverride[]>().notNull().default([]),
    expiresAt: timestamp("expires_at"),
    isArchived: boolean("is_archived").notNull().default(false),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_feature_flags_key").on(table.key),
    index("idx_feature_flags_is_archived").on(table.isArchived),
    index("idx_feature_flags_created_at").on(table.createdAt),
  ],
);

export const featureFlagsRelations = relations(featureFlags, ({ one }) => ({
  createdBy: one(users, {
    fields: [featureFlags.createdById],
    references: [users.id],
    relationName: "featureFlagCreatedBy",
  }),
  updatedBy: one(users, {
    fields: [featureFlags.updatedById],
    references: [users.id],
    relationName: "featureFlagUpdatedBy",
  }),
}));

export type FeatureFlag = typeof featureFlags.$inferSelect;
export type NewFeatureFlag = typeof featureFlags.$inferInsert;
