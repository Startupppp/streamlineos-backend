import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "./auth";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    action: text("action").notNull(),
    /**
     * Who acted, or NULL when no user did.
     *
     * NULL is the honest answer for an unattended action — a cron sweep, a
     * public unsubscribe link — and every reader already `leftJoin`s `users`,
     * so an actor that does not resolve costs them nothing. A sentinel id such
     * as the string "system" is not an option: `users` is the authentication
     * identity table, so a row there is a principal that surfaces in identity
     * lookups, member search and personal-data exports, and without such a row
     * the foreign key simply rejected the write. See migration 0663.
     */
    userId: text("user_id").references(() => users.id),
    // NOT "set null": chk_audit_logs_tenant_or_platform pins (org_id IS NULL) = is_platform_event,
    // so nulling a tenant row's org_id on organization delete raises 23514 instead of succeeding.
    orgId: text("org_id").references(() => organizations.id, { onDelete: "no action" }),
    targetId: text("target_id"),
    targetType: text("target_type"),
    actorUserId: text("actor_user_id"),
    actorMembershipId: integer("actor_membership_id"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    isPlatformEvent: boolean("is_platform_event").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "chk_audit_logs_tenant_or_platform",
      sql`(${table.orgId} IS NULL) = ${table.isPlatformEvent}`,
    ),
    /**
     * An unattributed row must name the system that acted.
     *
     * Nullable alone would make "no user acted" indistinguishable from "a user
     * acted and the id was lost", and the second is a silent audit defect. The
     * deal stage ledger and the activity timeline already answer this question
     * the same way: the system case is a real case that names itself rather
     * than an absence. `AuditService` enforces it in its types; this is the
     * backstop for anything that reaches the table another way.
     */
    check(
      "chk_audit_logs_actor_attributed",
      sql`${table.userId} IS NOT NULL OR (${table.metadata} IS NOT NULL AND jsonb_exists(${table.metadata}, 'systemActor'))`,
    ),
    // fk_audit_logs_org_actor_membership below is MATCH SIMPLE, so it does not
    // fire at all when org_id is NULL. Without this, a platform-event row could
    // name any organisation's membership and the composite FK would pass.
    check(
      "chk_audit_logs_membership_requires_org",
      sql`${table.actorMembershipId} IS NULL OR ${table.orgId} IS NOT NULL`,
    ),
    index("idx_audit_logs_user_id").on(table.userId),
    index("idx_audit_logs_org_actor_membership").on(table.orgId, table.actorMembershipId),
    foreignKey({
      columns: [table.orgId, table.actorMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_audit_logs_org_actor_membership",
    }).onDelete("set null"),
    index("idx_audit_logs_action").on(table.action),
    index("idx_audit_logs_created_at").on(table.createdAt),
    index("idx_audit_logs_org_created").on(table.orgId, table.createdAt),
    index("idx_audit_logs_org_action").on(table.orgId, table.action),
    index("idx_audit_logs_resource").on(
      table.orgId,
      table.resourceType,
      table.createdAt,
    ),
    index("idx_audit_logs_org_module_created").on(
      table.orgId,
      sql`(${table.metadata}->>'moduleKey')`,
      table.createdAt.desc(),
    ),
  ],
);
