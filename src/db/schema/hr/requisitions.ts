import { decimal, foreignKey, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";
import { jobPostings } from "./hiring-core";
import { headcountRequests } from "./hiring-pipeline";

export const jobRequisitions = pgTable("job_requisitions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  department: text("department"),
  location: text("location"),
  headcount: integer("headcount").default(1).notNull(),
  budgetMin: decimal("budget_min", { precision: 15, scale: 2 }),
  budgetMax: decimal("budget_max", { precision: 15, scale: 2 }),
  hiringManagerId: text("hiring_manager_id"),
  hiringManagerMembershipId: integer("hiring_manager_membership_id"),
  priority: text("priority").default("MEDIUM").notNull(),
  type: text("type").default("FULL_TIME").notNull(),
  status: text("status").default("DRAFT").notNull(),
  requestedBy: text("requested_by").notNull(),
  requestedByMembershipId: integer("requested_by_membership_id"),
  approverId: text("approver_id"),
  approverMembershipId: integer("approver_membership_id"),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  justification: text("justification"),
  targetDate: text("target_date"),
  linkedJobId: integer("linked_job_id"),
  headcountId: integer("headcount_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.linkedJobId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_job_requisitions_linked_job_id_org" }).onDelete("set null"),
  unique("uniq_job_requisitions_org_id").on(table.orgId, table.id),
  index("idx_requisitions_org_status").on(table.orgId, table.status),
  index("idx_requisitions_hiring_manager").on(table.hiringManagerId),
  foreignKey({ columns: [table.orgId, table.headcountId], foreignColumns: [headcountRequests.orgId, headcountRequests.id], name: "fk_job_requisitions_headcount_org" }).onDelete("set null"),
  index("idx_requisitions_headcount").on(table.orgId, table.headcountId),
]);
