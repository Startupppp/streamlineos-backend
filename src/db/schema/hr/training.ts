import { pgTable, text, serial, timestamp, boolean, integer, index, unique } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

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
  unique("uniq_training_programs_org_id").on(table.orgId, table.id),
  index("idx_training_programs_org_status").on(table.orgId, table.status),
]);
