import {
  pgTable,
  integer,
  text,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations, organizationMembers } from "../common/auth";
import { kbPages } from "./pages";

export const KB_HEALTH_ITEM_KINDS = [
  "unowned",
  "stale",
  "unverified",
  "empty",
  "overdue_review",
  "broken_link",
  "overexposed",
  "duplicate_candidate",
  "contradictory_claim",
] as const;

export const KB_REPAIR_ACTIONS = [
  "assign_owner",
  "request_review",
  "mark_needs_content",
] as const;

export type KbRepairAction = (typeof KB_REPAIR_ACTIONS)[number];

export type KbHealthItemKind = (typeof KB_HEALTH_ITEM_KINDS)[number];

export const KB_HEALTH_ITEM_STATES = ["open", "resolved", "dismissed"] as const;
export type KbHealthItemState = (typeof KB_HEALTH_ITEM_STATES)[number];

export const kbHealthItems = pgTable(
  "kb_health_items",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    pageId: integer("page_id").notNull(),
    kind: text("kind").$type<KbHealthItemKind>().notNull(),
    ruleVersion: integer("rule_version").notNull().default(1),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    impact: integer("impact").notNull().default(0),
    state: text("state").$type<KbHealthItemState>().notNull().default("open"),
    assigneeMembershipId: integer("assignee_membership_id"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedReason: text("dismissed_reason"),
    dismissalExpiresAt: timestamp("dismissal_expires_at", {
      withTimezone: true,
    }),
    repairAction: text("repair_action").$type<KbRepairAction>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("uniq_kb_health_items_org_id").on(table.orgId, table.id),
    index("idx_kb_health_items_org_state_impact").on(
      table.orgId,
      table.state,
      table.impact,
      table.id,
    ),
    index("idx_kb_health_items_org_kind_state").on(
      table.orgId,
      table.kind,
      table.state,
    ),
    index("idx_kb_health_items_org_page").on(table.orgId, table.pageId),
    index("idx_kb_health_items_org_assignee").on(
      table.orgId,
      table.assigneeMembershipId,
    ),
    index("idx_kb_health_items_org_due").on(table.orgId, table.dueAt),
    index("idx_kb_health_items_org_dismissal_expiry").on(
      table.orgId,
      table.dismissalExpiresAt,
    ),
    foreignKey({
      columns: [table.orgId, table.pageId],
      foreignColumns: [kbPages.orgId, kbPages.id],
      name: "fk_kb_health_items_org_page",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.assigneeMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_kb_health_items_org_assignee",
    }).onDelete("set null"),
  ],
);
