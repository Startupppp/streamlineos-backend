import {
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organizationMembers, organizations, users } from "../common/auth";
import { attendance } from "./attendance";

export const hrAttendanceRegularizations = pgTable("hr_attendance_regularizations", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  // Stable display identity. Tenant authority is userMembershipId.
  userId: text("user_id").notNull(),
  attendanceDate: date("attendance_date").notNull(),
  requestedCheckIn: timestamp("requested_check_in"),
  requestedCheckOut: timestamp("requested_check_out"),
  reason: text("reason").notNull(),
  status: text("status").default("PENDING").notNull(),
  workflowInstanceId: text("workflow_instance_id"),
  approvedBy: text("approved_by").references(() => users.id),
  approvedByMembershipId: integer("approved_by_membership_id"),
  approvedAt: timestamp("approved_at"),
  rejectedBy: text("rejected_by").references(() => users.id),
  rejectedByMembershipId: integer("rejected_by_membership_id"),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  attendanceId: integer("attendance_id"),
  userMembershipId: integer("user_membership_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.attendanceId], foreignColumns: [attendance.orgId, attendance.id], name: "fk_hr_attendance_regularizations_attendance_id_org" }).onDelete("set null"),
  unique("uniq_hr_attendance_regularizations_org_id").on(table.orgId, table.id),
  index("idx_att_reg_org_user").on(table.orgId, table.userId),
  index("idx_att_reg_org_date").on(table.orgId, table.attendanceDate),
  index("idx_att_reg_status").on(table.orgId, table.status),
  index("idx_hr_attendance_regularizations_org_user_membership").on(table.orgId, table.userMembershipId),
  index("idx_hr_attendance_regularizations_org_approved_by_membership").on(table.orgId, table.approvedByMembershipId),
  index("idx_hr_attendance_regularizations_org_rejected_by_membership").on(table.orgId, table.rejectedByMembershipId),
  foreignKey({
    columns: [table.orgId, table.userMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_attendance_regularizations_user_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.approvedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_attendance_regularizations_approved_by_actor",
  }).onDelete("set null"),
  foreignKey({
    columns: [table.orgId, table.rejectedByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_hr_attendance_regularizations_rejected_by_actor",
  }).onDelete("set null"),
]);
