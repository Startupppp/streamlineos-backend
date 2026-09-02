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
    userId: text("user_id")
      .references(() => users.id)
      .notNull(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "set null" }),
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
    index("idx_audit_logs_user_id").on(table.userId),
    index("idx_audit_logs_org_actor_membership").on(table.orgId, table.actorMembershipId),
    foreignKey({
      columns: [table.orgId, table.actorMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_audit_logs_org_actor_membership",
    }),
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
