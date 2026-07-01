import { pgTable, text, serial, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { organizations, users } from "../auth";

export const trainingPrograms = pgTable("training_programs", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").default("MANDATORY").notNull(),
  format: text("format").default("CLASSROOM").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date"),
  venue: text("venue"),
  virtualLink: text("virtual_link"),
  maxCapacity: integer("max_capacity"),
  instructorId: text("instructor_id").references(() => users.id, { onDelete: "set null" }),
  externalInstructor: text("external_instructor"),
  isMandatory: boolean("is_mandatory").default(false).notNull(),
  status: text("status").default("SCHEDULED").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_training_programs_org_status").on(table.orgId, table.status),
]);

export const trainingAttendance = pgTable("training_attendance", {
  id: serial("id").primaryKey(),
  programId: integer("program_id").references(() => trainingPrograms.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: text("status").default("ENROLLED").notNull(),
  feedbackRating: integer("feedback_rating"),
  feedbackText: text("feedback_text"),
  certificateUrl: text("certificate_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_training_attendance_program").on(table.programId),
  index("idx_training_attendance_user").on(table.userId),
]);
