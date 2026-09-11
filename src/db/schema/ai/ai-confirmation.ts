import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, unique, uniqueIndex, varchar, foreignKey } from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";

export const aiProposalStatusEnum = pgEnum("ai_proposal_status", [
  "PROPOSED",
  "CONFIRMED",
  "EXECUTED",
  "EXPIRED",
  "CANCELLED",
]);

export const aiActionProposals = pgTable(
  "ai_action_proposals",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    userMembershipId: integer("user_membership_id"),
    action: varchar("action", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    status: aiProposalStatusEnum("status").notNull().default("PROPOSED"),
    idempotencyKey: varchar("idempotency_key", { length: 120 }),
    expiresAt: timestamp("expires_at").notNull(),
    executedAt: timestamp("executed_at"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (t) => [
    index("idx_ai_proposals_org_user_created").on(t.orgId, t.userMembershipId, t.createdAt),
    index("idx_ai_proposals_status_expires").on(t.status, t.expiresAt),
    uniqueIndex("uq_ai_proposals_org_idem_key")
      .on(t.orgId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    unique("uniq_ai_action_proposals_org_id").on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_ai_proposals_org_user_mbr",
    }).onDelete("set null"),
  ],
);
