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
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id"),
    assignedAt: timestamp("assigned_at").defaultNow().notNull(),
    assignedBy: text("assigned_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("uniq_ticket_assignees_ticket_user").on(
      table.ticketId,
      table.userId,
    ),
    index("idx_ticket_assignees_user_id").on(table.userId),
    index("idx_ticket_assignees_org_user_ticket").on(
      table.orgId,
      table.userId,
      table.ticketId,
    ),
    index("idx_ticket_assignees_org_member_membership").on(table.orgId, table.membershipId),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_ticket_assignees_member_actor",
    }).onDelete("restrict"),
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
      .references(() => tickets.id, { onDelete: "cascade" })
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
    foreignKey({
      columns: [table.parentCommentId],
      foreignColumns: [table.id],
    }).onDelete("cascade"),
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
      .references(() => tickets.id, { onDelete: "cascade" })
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
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    labelId: integer("label_id")
      .references(() => ticketLabels.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_ticket_label_mappings_ticket_label").on(
      table.ticketId,
      table.labelId,
    ),
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
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_ticket_watcher").on(table.ticketId, table.userId),
    index("idx_ticket_watchers_user").on(table.userId),
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
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull().default("Checklist"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
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
      .references(() => ticketChecklists.id, { onDelete: "cascade" })
      .notNull(),
    text: text("text").notNull(),
    isCompleted: boolean("is_completed").default(false).notNull(),
    assigneeId: text("assignee_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dueDate: date("due_date"),
    order: integer("order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ticket_checklist_items_checklist").on(table.checklistId),
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
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    fieldDefinitionId: integer("field_definition_id")
      .references(() => customFieldDefinitions.id, { onDelete: "cascade" })
      .notNull(),
    value: text("value"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_ticket_custom_field_values").on(
      table.ticketId,
      table.fieldDefinitionId,
    ),
    index("idx_ticket_custom_field_values_ticket").on(table.ticketId),
    unique("uniq_tcfv_org_id").on(table.orgId, table.id),
  ],
);

export const ticketCommentReactions = build.table(
  "ticket_comment_reactions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    commentId: bigint("comment_id", { mode: "number" })
      .notNull()
      .references(() => ticketComments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    emoji: varchar("emoji", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_comment_reaction_user_emoji").on(
      t.commentId,
      t.userId,
      t.emoji,
    ),
    index("idx_comment_reactions_comment_id").on(t.commentId),
    unique("uniq_ticket_comment_reactions_org_id").on(t.orgId, t.id),
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
      .references(() => tickets.id, { onDelete: "cascade" })
      .notNull(),
    url: text("url").notNull(),
    label: text("label"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_ticket_related_links_ticket").on(table.ticketId)],
);
