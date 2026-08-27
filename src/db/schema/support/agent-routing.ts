import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const supportAgentSkills = pgTable(
  "support_agent_skills",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    skill: text("skill").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_agent_skills_org_user_skill").on(table.orgId, table.userId, table.skill),
    index("idx_support_agent_skills_org").on(table.orgId, table.skill),
    unique("uniq_support_agent_skills_org_id").on(table.orgId, table.id),
  ],
);

/** No row for a user = available by default (opt-out model, not opt-in). */
export const supportAgentAvailability = pgTable(
  "support_agent_availability",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
    isAvailable: boolean("is_available").default(true).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_support_agent_availability_org_user").on(table.orgId, table.userId),
    unique("uniq_support_agent_avail_org_id").on(table.orgId, table.id),
  ],
);

export const supportVipClients = pgTable(
  "support_vip_clients",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    clientId: integer("client_id").notNull(),
    /**
    * The party this row belongs to. Ticket 08's expand.
    *
    * Beside `client_id` rather than replacing it: every existing reader keeps
    * working while readers move over one at a time, and the old column goes in
    * the contract migration once none is left. Nullable until then -- a null
    * means "not yet backfilled", which is a state worth being able to see.
    */
    clientPartyId: text("client_party_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_vip_clients_org_client").on(table.orgId, table.clientId),
    unique("uniq_support_vip_clients_org_id").on(table.orgId, table.id),
  ],
);
