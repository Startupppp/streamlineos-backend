import { foreignKey, index, integer, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { candidates } from "./hiring-candidates";

export const talentPools = pgTable("talent_pools", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_talent_pools_org_id").on(table.orgId, table.id),
]);

export const talentPoolMembers = pgTable("talent_pool_members", {
  id: serial("id").primaryKey(),
  poolId: integer("pool_id").notNull(),
  candidateId: integer("candidate_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  notes: text("notes"),
  addedBy: text("added_by"),
  addedAt: timestamp("added_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_talent_pool_members_org_candidate" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.poolId], foreignColumns: [talentPools.orgId, talentPools.id], name: "fk_talent_pool_members_org_pool" }).onDelete("cascade"),
  unique("uniq_talent_pool_members_org_id").on(table.orgId, table.id),
  uniqueIndex("uq_talent_pool_members_pool_candidate").on(table.poolId, table.candidateId),
  index("idx_talent_pool_members_candidate").on(table.candidateId),
]);

export const talentPoolsRelations = relations(talentPools, ({ many }) => ({
  members: many(talentPoolMembers),
}));

export const talentPoolMembersRelations = relations(talentPoolMembers, ({ one }) => ({
  pool: one(talentPools, { fields: [talentPoolMembers.poolId], references: [talentPools.id] }),
  candidate: one(candidates, { fields: [talentPoolMembers.candidateId], references: [candidates.id] }),
}));
