import { pgTable, pgEnum, text, serial, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { tickets } from "./tasks";

export const gitProviderEnum = pgEnum("git_provider", ["github", "gitlab", "bitbucket"]);
export const gitRefTypeEnum = pgEnum("git_ref_type", ["commit", "pull_request", "branch"]);

export const gitConnections = pgTable("git_connections", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  provider: gitProviderEnum("provider").notNull(),
  repoUrl: text("repo_url").notNull(),
  repoName: text("repo_name"),
  webhookSecret: text("webhook_secret").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_git_connections_org").on(table.orgId),
]);

export const gitTicketLinks = pgTable("git_ticket_links", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").references(() => tickets.id, { onDelete: "cascade" }).notNull(),
  connectionId: integer("connection_id").references(() => gitConnections.id, { onDelete: "set null" }),
  provider: gitProviderEnum("provider").notNull(),
  refType: gitRefTypeEnum("ref_type").notNull(),
  externalId: text("external_id").notNull(),
  title: text("title"),
  url: text("url"),
  author: text("author"),
  status: text("status"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_git_ticket_links_ticket").on(table.ticketId),
  uniqueIndex("uniq_git_ticket_links_ref").on(table.ticketId, table.refType, table.externalId),
]);

export const gitConnectionsRelations = relations(gitConnections, ({ one, many }) => ({
  organization: one(organizations, { fields: [gitConnections.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [gitConnections.createdBy], references: [users.id] }),
  links: many(gitTicketLinks),
}));

export const gitTicketLinksRelations = relations(gitTicketLinks, ({ one }) => ({
  organization: one(organizations, { fields: [gitTicketLinks.orgId], references: [organizations.id] }),
  ticket: one(tickets, { fields: [gitTicketLinks.ticketId], references: [tickets.id] }),
  connection: one(gitConnections, { fields: [gitTicketLinks.connectionId], references: [gitConnections.id] }),
}));
