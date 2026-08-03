import { pgTable, text, serial, timestamp, date, integer, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";
import { attendance } from "./attendance";

export const hrAttendanceRegularizations = pgTable("hr_attendance_regularizations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  attendanceDate: date("attendance_date").notNull(),
  requestedCheckIn: timestamp("requested_check_in"),
  requestedCheckOut: timestamp("requested_check_out"),
  reason: text("reason").notNull(),
  status: text("status").default("PENDING").notNull(),
  workflowInstanceId: text("workflow_instance_id"),
  approvedBy: text("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  rejectedBy: text("rejected_by").references(() => users.id),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  attendanceId: integer("attendance_id").references(() => attendance.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_attendance_regularizations_org_id").on(table.orgId, table.id),
  index("idx_att_reg_org_user").on(table.orgId, table.userId),
  index("idx_att_reg_org_date").on(table.orgId, table.attendanceDate),
  index("idx_att_reg_status").on(table.orgId, table.status),
]);
