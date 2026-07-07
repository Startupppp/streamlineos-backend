import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";
import { clients } from "../crm/contacts";

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
    uniqueIndex("uniq_support_agent_skills_user_skill").on(table.userId, table.skill),
    index("idx_support_agent_skills_org").on(table.orgId, table.skill),
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
  (table) => [uniqueIndex("uniq_support_agent_availability_user").on(table.userId)],
);

export const supportVipClients = pgTable(
  "support_vip_clients",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("uniq_support_vip_clients_org_client").on(table.orgId, table.clientId)],
);
