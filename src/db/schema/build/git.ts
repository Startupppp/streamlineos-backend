import { bigint, boolean, foreignKey, index, integer, pgEnum, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { projects } from "./core";
import { tickets } from "./tasks";

export const gitProviderEnum = pgEnum("git_provider", ["github", "gitlab", "bitbucket"]);
export const gitRefTypeEnum = pgEnum("git_ref_type", ["commit", "pull_request", "branch"]);

export const gitConnections = build.table("git_connections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id"),
  provider: gitProviderEnum("provider").notNull(),
  repoUrl: text("repo_url").notNull(),
  repoName: text("repo_name"),
  webhookSecret: text("webhook_secret").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_git_connections_org_project" }).onDelete("set null"),
  index("idx_git_connections_org").on(table.orgId),
  index("idx_git_connections_project").on(table.projectId),
  unique("uniq_git_connections_org_id").on(table.orgId, table.id),
]);

export const gitTicketLinks = build.table("git_ticket_links", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").notNull(),
  connectionId: integer("connection_id"),
  provider: gitProviderEnum("provider").notNull(),
  refType: gitRefTypeEnum("ref_type").notNull(),
  externalId: text("external_id").notNull(),
  title: text("title"),
  url: text("url"),
  author: text("author"),
  status: text("status"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.connectionId], foreignColumns: [gitConnections.orgId, gitConnections.id], name: "fk_git_ticket_links_org_connection" }).onDelete("set null"),
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_git_ticket_links_org_ticket" }).onDelete("cascade"),
  index("idx_git_ticket_links_ticket").on(table.ticketId),
  uniqueIndex("uniq_git_ticket_links_ref").on(table.ticketId, table.refType, table.externalId),
  unique("uniq_git_ticket_links_org_id").on(table.orgId, table.id),
]);

export const gitWebhookSeenDeliveries = build.table("git_webhook_seen_deliveries", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  provider: text("provider").notNull(),
  deliveryId: text("delivery_id").notNull(),
  seenAt: timestamp("seen_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_git_webhook_seen_deliveries_delivery").on(table.orgId, table.provider, table.deliveryId),
  index("idx_git_webhook_seen_deliveries_org_seen_at").on(table.orgId, table.seenAt),
]);

export const gitConnectionsRelations = relations(gitConnections, ({ one, many }) => ({
  organization: one(organizations, { fields: [gitConnections.orgId], references: [organizations.id] }),
  project: one(projects, { fields: [gitConnections.projectId], references: [projects.id] }),
  creator: one(users, { fields: [gitConnections.createdBy], references: [users.id] }),
  links: many(gitTicketLinks),
}));

export const gitTicketLinksRelations = relations(gitTicketLinks, ({ one }) => ({
  organization: one(organizations, { fields: [gitTicketLinks.orgId], references: [organizations.id] }),
  ticket: one(tickets, { fields: [gitTicketLinks.ticketId], references: [tickets.id] }),
  connection: one(gitConnections, { fields: [gitTicketLinks.connectionId], references: [gitConnections.id] }),
}));
