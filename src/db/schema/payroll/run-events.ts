import { foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { payrollRunEventTypeEnum } from "./enums";
import { payrollRuns } from "./runs";

export const payrollRunEvents = pgTable("payroll_run_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  runId: integer("run_id").notNull(),
  type: payrollRunEventTypeEnum("type").notNull(),
  actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
  reason: text("reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.runId], foreignColumns: [payrollRuns.orgId, payrollRuns.id], name: "fk_payroll_run_events_run_id_org" }).onDelete("cascade"),
  unique("uniq_payroll_run_events_org_id").on(table.orgId, table.id),
  index("idx_payroll_run_events_run").on(table.runId),
  index("idx_payroll_run_events_org_type").on(table.orgId, table.type),
  index("idx_payroll_run_events_org_created").on(table.orgId, table.createdAt),
]);

export const payrollRunEventsRelations = relations(payrollRunEvents, ({ one }) => ({
  organization: one(organizations, {
    fields: [payrollRunEvents.orgId],
    references: [organizations.id],
  }),
  run: one(payrollRuns, {
    fields: [payrollRunEvents.runId],
    references: [payrollRuns.id],
  }),
  actor: one(users, {
    fields: [payrollRunEvents.actorId],
    references: [users.id],
  }),
}));
