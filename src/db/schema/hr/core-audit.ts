import {
  pgTable,
  text,
  serial,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

export const hrAuditLogs = pgTable("hr_audit_logs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_audit_logs_org_id").on(table.orgId, table.id),
  index("idx_hr_audit_logs_org").on(table.orgId),
  index("idx_hr_audit_logs_org_entity").on(table.orgId, table.entityType, table.entityId),
  index("idx_hr_audit_logs_actor").on(table.actorId),
  index("idx_hr_audit_logs_created_at").on(table.createdAt),
  index("idx_hr_audit_logs_org_action").on(table.orgId, table.action),
]);

export const hrAuditLogsRelations = relations(hrAuditLogs, ({ one }) => ({
  org: one(organizations, { fields: [hrAuditLogs.orgId], references: [organizations.id] }),
  actor: one(users, { fields: [hrAuditLogs.actorId], references: [users.id] }),
}));
