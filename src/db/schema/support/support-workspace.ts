import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { supportTickets } from "./tickets";

export const supportSavedViewVisibilityEnum = pgEnum("support_saved_view_visibility", [
  "personal",
  "team",
  "global",
]);

export const supportTicketLinkRelationEnum = pgEnum("support_ticket_link_relation", [
  "duplicate",
  "related",
  "split",
]);

export const supportQueues = pgTable(
  "support_queues",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    filter: jsonb("filter").$type<Record<string, unknown>>().default({}).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_support_queues_org_sort").on(table.orgId, table.sortOrder),
    unique("uniq_support_queues_org_id").on(table.orgId, table.id),
  ],
);

export const supportSavedViews = pgTable(
  "support_saved_views",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ownerMembershipId: integer("owner_membership_id"),
    name: text("name").notNull(),
    filter: jsonb("filter").$type<Record<string, unknown>>().default({}).notNull(),
    visibility: supportSavedViewVisibilityEnum("visibility").default("personal").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_support_saved_views_org_id").on(table.orgId, table.id),
    index("idx_support_saved_views_org_owner_actor").on(table.orgId, table.ownerMembershipId),
    foreignKey({
      columns: [table.orgId, table.ownerMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_support_saved_views_owner_actor",
    }).onDelete("cascade"),
  ],
);

export const supportTicketWatchers = pgTable(
  "support_ticket_watchers",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    userMembershipId: integer("user_membership_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_ticket_watchers_ticket_membership").on(table.ticketId, table.userMembershipId),
    index("idx_support_ticket_watchers_org_ticket").on(table.orgId, table.ticketId),
    unique("uniq_support_ticket_watchers_org_id").on(table.orgId, table.id),
    index("idx_support_ticket_watchers_org_user_actor").on(table.orgId, table.userMembershipId),
    foreignKey({
      columns: [table.orgId, table.userMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_support_ticket_watchers_user_actor",
    }).onDelete("cascade"),
  ],
);

export const supportTags = pgTable(
  "support_tags",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_tags_org_name").on(table.orgId, table.name),
    unique("uniq_support_tags_org_id").on(table.orgId, table.id),
  ],
);

export const supportTicketTags = pgTable(
  "support_ticket_tags",
  {
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    tagId: integer("tag_id").references(() => supportTags.id, { onDelete: "cascade" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ticketId, table.tagId] }),
    index("idx_support_ticket_tags_tag").on(table.tagId),
  ],
);

export const supportTicketLinks = pgTable(
  "support_ticket_links",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    ticketId: integer("ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    linkedTicketId: integer("linked_ticket_id").references(() => supportTickets.id, { onDelete: "cascade" }).notNull(),
    relation: supportTicketLinkRelationEnum("relation").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_support_ticket_links_ticket_linked").on(table.ticketId, table.linkedTicketId),
    index("idx_support_ticket_links_org_ticket").on(table.orgId, table.ticketId),
    unique("uniq_support_ticket_links_org_id").on(table.orgId, table.id),
  ],
);

export const supportQueuesRelations = relations(supportQueues, ({ one }) => ({
  organization: one(organizations, { fields: [supportQueues.orgId], references: [organizations.id] }),
}));

export const supportSavedViewsRelations = relations(supportSavedViews, ({ one }) => ({
  organization: one(organizations, { fields: [supportSavedViews.orgId], references: [organizations.id] }),
}));

export const supportTicketWatchersRelations = relations(supportTicketWatchers, ({ one }) => ({
  ticket: one(supportTickets, { fields: [supportTicketWatchers.ticketId], references: [supportTickets.id] }),
  membership: one(organizationMembers, { fields: [supportTicketWatchers.userMembershipId], references: [organizationMembers.id] }),
}));

export const supportTagsRelations = relations(supportTags, ({ many }) => ({
  ticketTags: many(supportTicketTags),
}));

export const supportTicketTagsRelations = relations(supportTicketTags, ({ one }) => ({
  ticket: one(supportTickets, { fields: [supportTicketTags.ticketId], references: [supportTickets.id] }),
  tag: one(supportTags, { fields: [supportTicketTags.tagId], references: [supportTags.id] }),
}));

export const supportTicketLinksRelations = relations(supportTicketLinks, ({ one }) => ({
  ticket: one(supportTickets, {
    fields: [supportTicketLinks.ticketId],
    references: [supportTickets.id],
  }),
  linkedTicket: one(supportTickets, {
    fields: [supportTicketLinks.linkedTicketId],
    references: [supportTickets.id],
  }),
}));
