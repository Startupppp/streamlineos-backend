import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../auth";

export const hrAccessRequests = pgTable("hr_access_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  employeeId: text("employee_id").notNull(),
  systemName: text("system_name").notNull(),
  accessLevel: text("access_level").notNull(),
  status: text("status").notNull().default("requested"),
  grantedBy: text("granted_by"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_hr_access_requests_org").on(table.orgId),
  index("idx_hr_access_requests_employee").on(table.employeeId),
]);

export const hrAccessRequestsRelations = relations(hrAccessRequests, ({ one }) => ({
  organization: one(organizations, { fields: [hrAccessRequests.orgId], references: [organizations.id] }),
}));
