import {
  text,
  bigserial,
  bigint,
  timestamp,
  boolean,
  date,
  integer,
  foreignKey,
  index,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { tickets } from "./ticket-core";
import { customFieldDefinitions } from "../custom-field-engine";
import { build, buildEvents } from "./namespaces";

export const ticketAssignees = build.table(
  "ticket_assignees",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    assignedAt: timestamp("assigned_at").defaultNow().notNull(),
    assignedBy: text("assigned_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_ticket_assignees_org_ticket" }).onDelete("cascade"),
    uniqueIndex("uniq_ticket_assignees_ticket_user").on(
      table.ticketId,
      table.membershipId,
    ),
    index("idx_ticket_assignees_org_user_ticket").on(
      table.orgId,
      table.membershipId,
      table.ticketId,
    ),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_ticket_assignees_member_actor",
    }).onDelete("cascade"),
  ],
);

export const ticketComments = buildEvents.table(
  "ticket_comments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    userId: text("user_id")
      .references(() => users.id)
      .notNull(),
    content: text("content").notNull(),
    clientVisible: boolean("client_visible").notNull().default(false),
    parentCommentId: bigint("parent_comment_id", { mode: "number" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_ticket_comments_org_ticket" }).onDelete("cascade"),
    foreignKey({ columns: [table.orgId, table.parentCommentId], foreignColumns: [table.orgId, table.id], name: "fk_ticket_comments_org_parent" }).onDelete("cascade"),
    index("idx_ticket_comments_ticket").on(table.ticketId).where(sql`deleted_at IS NULL`),
    unique("uniq_ticket_comments_org_id").on(table.orgId, table.id),
  ],
);

export const ticketAttachments = build.table(
  "ticket_attachments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    fileUrl: text("file_url").notNull(),
    fileName: text("file_name").notNull(),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    uploadedBy: text("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    clientVisible: boolean("client_visible").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_ticket_attachments_org_ticket" }).onDelete("cascade"),
    index("idx_ticket_attachments_ticket").on(table.ticketId),
    unique("uniq_ticket_attachments_org_id").on(table.orgId, table.id),
  ],
);

export const ticketLabels = build.table(
  "ticket_labels",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    color: text("color").default("#3B82F6").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_ticket_labels_org_name").on(table.orgId, table.name),
    unique("uniq_ticket_labels_org_id").on(table.orgId, table.id),
  ],
);

export const ticketLabelMappings = build.table(
  "ticket_label_mappings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    labelId: integer("label_id")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.labelId], foreignColumns: [ticketLabels.orgId, ticketLabels.id], name: "fk_ticket_label_mappings_org_label" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_ticket_label_mappings_org_ticket" }).onDelete("cascade"),
    uniqueIndex("uniq_ticket_label_mappings_ticket_label").on(
      table.ticketId,
      table.labelId,
    ),
    unique("uniq_ticket_label_mappings_org_id").on(table.orgId, table.id),
  ],
);

export const ticketWatchers = build.table(
  "ticket_watchers",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_ticket_watchers_org_ticket" }).onDelete("cascade"),
    uniqueIndex("uniq_ticket_watcher").on(table.ticketId, table.membershipId),
    index("idx_ticket_watchers_org_membership").on(table.orgId, table.membershipId),
    foreignKey({
      name: "fk_ticket_watchers_actor",
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

export const ticketChecklists = build.table(
  "ticket_checklists",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    title: text("title").notNull().default("Checklist"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_ticket_checklists_org_ticket" }).onDelete("cascade"),
    index("idx_ticket_checklists_ticket").on(table.ticketId),
    unique("uniq_ticket_checklists_org_id").on(table.orgId, table.id),
  ],
);

export const ticketChecklistItems = build.table(
  "ticket_checklist_items",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    checklistId: integer("checklist_id")
      .notNull(),
    text: text("text").notNull(),
    isCompleted: boolean("is_completed").default(false).notNull(),
    assigneeId: text("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assigneeMembershipId: integer("assignee_membership_id"),
    dueDate: date("due_date"),
    order: integer("order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.checklistId], foreignColumns: [ticketChecklists.orgId, ticketChecklists.id], name: "fk_ticket_checklist_items_org_checklist" }).onDelete("cascade"),
    index("idx_ticket_checklist_items_checklist").on(table.checklistId),
    index("idx_ticket_checklist_items_org_assignee_membership").on(table.orgId, table.assigneeMembershipId),
    foreignKey({
      name: "fk_ticket_checklist_items_assignee_actor",
      columns: [table.orgId, table.assigneeMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
  ],
);

export const ticketCustomFieldValues = build.table(
  "ticket_custom_field_values",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    fieldDefinitionId: integer("field_definition_id")
      .notNull(),
    value: text("value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.fieldDefinitionId], foreignColumns: [customFieldDefinitions.orgId, customFieldDefinitions.id], name: "fk_ticket_cfield_values_org_def" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_ticket_cfield_values_org_ticket" }).onDelete("cascade"),
    uniqueIndex("uniq_ticket_custom_field_values").on(
      table.ticketId,
      table.fieldDefinitionId,
    ),
    unique("uniq_tcfv_org_id").on(table.orgId, table.id),
  ],
);

export const ticketCommentReactions = build.table(
  "ticket_comment_reactions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    commentId: bigint("comment_id", { mode: "number" })
      .notNull()
      ,
    membershipId: integer("membership_id").notNull(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    emoji: varchar("emoji", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.commentId], foreignColumns: [ticketComments.orgId, ticketComments.id], name: "fk_ticket_comment_reactions_org_comment" }).onDelete("cascade"),
    uniqueIndex("uq_comment_reaction_user_emoji").on(
      t.commentId,
      t.membershipId,
      t.emoji,
    ),
    index("idx_comment_reactions_org_membership").on(t.orgId, t.membershipId),
    unique("uniq_ticket_comment_reactions_org_id").on(t.orgId, t.id),
    foreignKey({
      name: "fk_ticket_comment_reactions_actor",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

export const ticketRelatedLinks = build.table(
  "ticket_related_links",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    ticketId: integer("ticket_id")
      .notNull(),
    url: text("url").notNull(),
    label: text("label"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.ticketId], foreignColumns: [tickets.orgId, tickets.id], name: "fk_ticket_related_links_org_ticket" }).onDelete("cascade"),
    index("idx_ticket_related_links_ticket").on(table.ticketId),
    unique("uniq_ticket_related_links_org_id").on(table.orgId, table.id),
    foreignKey({
      name: "fk_ticket_related_links_created_by_actor",
      columns: [table.orgId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("set null"),
  ],
);
