import { pgTable, text, serial, timestamp, boolean, integer, index, unique, foreignKey, type AnyPgColumn } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { supportTicketStatusEnum, supportTicketPriorityEnum } from "../common/enums";
import { organizations, users, organizationMembers } from "../common/auth";
import { clients } from "../crm/contacts";

export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  clientId: integer("client_id"),
  assigneeMembershipId: integer("assignee_membership_id"),
  title: text("title").notNull(),
  category: text("category"),
  description: text("description"),
  requesterEmail: text("requester_email"),
  requesterName: text("requester_name"),
  status: supportTicketStatusEnum("status").default("OPEN").notNull(),
  priority: supportTicketPriorityEnum("priority").default("MEDIUM").notNull(),
  slaDeadline: timestamp("sla_deadline"),
  firstResponseDueAt: timestamp("first_response_due_at"),
  firstRespondedAt: timestamp("first_responded_at"),
  slaPausedAt: timestamp("sla_paused_at"),
  slaPausedMinutes: integer("sla_paused_minutes").default(0).notNull(),
  slaEscalationLevel: integer("sla_escalation_level").default(0).notNull(),
  resolvedAt: timestamp("resolved_at"),
  closedAt: timestamp("closed_at"),
  queueId: integer("queue_id"),
  mergedIntoTicketId: integer("merged_into_ticket_id").references((): AnyPgColumn => supportTickets.id, { onDelete: "set null" }),
  snoozedUntil: timestamp("snoozed_until"),
  snoozedBy: text("snoozed_by").references(() => users.id),
  createdByMembershipId: integer("created_by_membership_id").notNull(),
  sourceChannel: text("source_channel").default("web").notNull(),
  sourceMessageId: text("source_message_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_support_tickets_org_status").on(table.orgId, table.status),
  index("idx_support_tickets_org_assignee_actor").on(table.orgId, table.assigneeMembershipId, table.createdAt),
  index("idx_support_tickets_org_created_actor").on(table.orgId, table.createdByMembershipId),
  foreignKey({
    columns: [table.orgId, table.assigneeMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_support_tickets_assignee_actor",
  }).onDelete("set null"),
  // No onDelete: createdByMembershipId is the ticket's only creator identity and
  // is not nullable, so SET NULL could only raise 23502. 0992 made it NO ACTION.
  foreignKey({
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_support_tickets_created_actor",
  }),
  foreignKey({
    columns: [table.orgId, table.clientId],
    foreignColumns: [clients.orgId, clients.id],
    name: "fk_support_tickets_client_id_org",
  }),
  // Queue view: filter by org + queue + open statuses, order by priority then SLA deadline.
  index("idx_support_tickets_org_queue_status_priority").on(table.orgId, table.queueId, table.status, table.priority, table.createdAt),
  index("idx_support_tickets_client").on(table.clientId),
  index("idx_support_tickets_priority").on(table.priority),
  index("idx_support_tickets_sla").on(table.slaDeadline),
  index("idx_support_tickets_source_message").on(table.sourceMessageId),
  index("idx_support_tickets_snoozed_until").on(table.snoozedUntil),
  unique("uniq_support_tickets_org_id").on(table.orgId, table.id),
]);

export const supportTicketMessages = pgTable("support_ticket_messages", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  ticketId: integer("ticket_id").notNull(),
  authorId: text("author_id").references(() => users.id),
  body: text("body").notNull(),
  isInternal: boolean("is_internal").default(false).notNull(),
  sourceChannel: text("source_channel").default("web").notNull(),
  sourceMessageId: text("source_message_id"),
  sourceContactEmail: text("source_contact_email"),
  sourceContactName: text("source_contact_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [supportTickets.orgId, supportTickets.id], name: "fk_support_ticket_messages_ticket_id_org" }).onDelete("cascade"),
  unique("uniq_support_ticket_messages_org_id").on(table.orgId, table.id),
  index("idx_support_ticket_messages_ticket").on(table.ticketId),
  index("idx_support_ticket_messages_author").on(table.authorId),
  index("idx_support_ticket_messages_source_message").on(table.sourceMessageId),
]);

export const supportTicketAttachments = pgTable("support_ticket_attachments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  messageId: integer("message_id").notNull(),
  fileName: text("file_name").notNull(),
  fileUrl: text("file_url").notNull(),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.messageId], foreignColumns: [supportTicketMessages.orgId, supportTicketMessages.id], name: "fk_support_ticket_attachments_message_id_org" }).onDelete("cascade"),
  index("idx_support_ticket_attachments_message").on(table.messageId),
  unique("uniq_support_ticket_attachments_org_id").on(table.orgId, table.id),
]);

export const supportTicketsRelations = relations(supportTickets, ({ one, many }) => ({
  organization: one(organizations, { fields: [supportTickets.orgId], references: [organizations.id] }),
  client: one(clients, { fields: [supportTickets.clientId], references: [clients.id] }),
  assigneeMembership: one(organizationMembers, {
    fields: [supportTickets.assigneeMembershipId],
    references: [organizationMembers.id],
  }),
  creatorMembership: one(organizationMembers, {
    fields: [supportTickets.createdByMembershipId],
    references: [organizationMembers.id],
  }),
  messages: many(supportTicketMessages),
}));

export const supportTicketMessagesRelations = relations(supportTicketMessages, ({ one, many }) => ({
  ticket: one(supportTickets, { fields: [supportTicketMessages.ticketId], references: [supportTickets.id] }),
  author: one(users, { fields: [supportTicketMessages.authorId], references: [users.id] }),
  attachments: many(supportTicketAttachments),
}));

export const supportTicketAttachmentsRelations = relations(supportTicketAttachments, ({ one }) => ({
  message: one(supportTicketMessages, {
    fields: [supportTicketAttachments.messageId],
    references: [supportTicketMessages.id],
  }),
  organization: one(organizations, {
    fields: [supportTicketAttachments.orgId],
    references: [organizations.id],
  }),
}));
