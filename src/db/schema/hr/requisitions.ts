import { pgTable, text, serial, timestamp, decimal, integer, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { jobPostings } from "./hiring-core";

export const jobRequisitions = pgTable("job_requisitions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  department: text("department"),
  location: text("location"),
  headcount: integer("headcount").default(1).notNull(),
  budgetMin: decimal("budget_min", { precision: 15, scale: 2 }),
  budgetMax: decimal("budget_max", { precision: 15, scale: 2 }),
  hiringManagerId: text("hiring_manager_id").references(() => users.id),
  priority: text("priority").default("MEDIUM").notNull(),
  type: text("type").default("FULL_TIME").notNull(),
  status: text("status").default("DRAFT").notNull(),
  requestedBy: text("requested_by").references(() => users.id).notNull(),
  approverId: text("approver_id").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  justification: text("justification"),
  targetDate: text("target_date"),
  linkedJobId: integer("linked_job_id").references(() => jobPostings.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_job_requisitions_org_id").on(table.orgId, table.id),
  index("idx_requisitions_org_status").on(table.orgId, table.status),
  index("idx_requisitions_hiring_manager").on(table.hiringManagerId),
]);
