import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { candidates } from "./hiring";

export const talentPools = pgTable("talent_pools", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_talent_pools_org").on(table.orgId),
]);

export const talentPoolMembers = pgTable("talent_pool_members", {
  id: serial("id").primaryKey(),
  poolId: integer("pool_id").references(() => talentPools.id, { onDelete: "cascade" }).notNull(),
  candidateId: integer("candidate_id").references(() => candidates.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  notes: text("notes"),
  addedBy: text("added_by").references(() => users.id),
  addedAt: timestamp("added_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_talent_pool_members_pool_candidate").on(table.poolId, table.candidateId),
  index("idx_talent_pool_members_pool").on(table.poolId),
  index("idx_talent_pool_members_candidate").on(table.candidateId),
]);

export const talentPoolsRelations = relations(talentPools, ({ many }) => ({
  members: many(talentPoolMembers),
}));

export const talentPoolMembersRelations = relations(talentPoolMembers, ({ one }) => ({
  pool: one(talentPools, { fields: [talentPoolMembers.poolId], references: [talentPools.id] }),
  candidate: one(candidates, { fields: [talentPoolMembers.candidateId], references: [candidates.id] }),
}));
