import { pgTable, pgEnum, serial, text, boolean, jsonb, timestamp, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";

export const supportChannelTypeEnum = pgEnum("support_channel_type", [
  "email",
  "chat",
  "whatsapp",
  "sms",
]);

export const supportChannels = pgTable(
  "support_channels",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    type: supportChannelTypeEnum("type").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    inboundSecret: text("inbound_secret"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_support_channels_org_type_name").on(table.orgId, table.type, table.name),
    unique("uniq_support_channels_org_id").on(table.orgId, table.id),
  ],
);

export const supportChannelsRelations = relations(supportChannels, ({ one }) => ({
  organization: one(organizations, { fields: [supportChannels.orgId], references: [organizations.id] }),
}));
