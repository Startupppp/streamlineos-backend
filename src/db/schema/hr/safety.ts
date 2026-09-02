import { boolean, foreignKey, index, integer, jsonb, pgEnum, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

export const hrSafetyIncidentTypeEnum = pgEnum("hr_safety_incident_type", [
  "injury",
  "accident",
  "near_miss",
  "hazard",
  "environmental",
  "other",
]);

export const hrSafetyIncidentStatusEnum = pgEnum("hr_safety_incident_status", [
  "open",
  "investigating",
  "mitigated",
  "closed",
]);

export const hrSafetyIncidentSeverityEnum = pgEnum("hr_safety_incident_severity", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const hrSafetyIncidents = pgTable("hr_safety_incidents", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  incidentNumber: text("incident_number").notNull(),
  type: hrSafetyIncidentTypeEnum("type").notNull(),
  location: text("location").notNull(),
  occurredAt: timestamp("occurred_at").notNull(),
  reportedBy: text("reported_by").references(() => users.id).notNull(),
  description: text("description").notNull(),
  severity: hrSafetyIncidentSeverityEnum("severity").notNull(),
  status: hrSafetyIncidentStatusEnum("status").default("open").notNull(),
  medicalAttention: boolean("medical_attention").default(false).notNull(),
  confidentialMedicalNote: text("confidential_medical_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
}, (table) => [
  unique("uniq_hr_safety_incidents_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_safety_incidents_org_number").on(table.orgId, table.incidentNumber),
  index("idx_hr_safety_incidents_org_status").on(table.orgId, table.status),
  index("idx_hr_safety_incidents_org_type").on(table.orgId, table.type),
  index("idx_hr_safety_incidents_org_occurred").on(table.orgId, table.occurredAt),
]);

export const hrWellnessCheckins = pgTable("hr_wellness_checkins", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  date: text("date").notNull(),
  score: integer("score").notNull(),
  flags: jsonb("flags").$type<string[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_hr_wellness_checkins_org_id").on(table.orgId, table.id),
  uniqueIndex("uniq_hr_wellness_org_user_date").on(table.orgId, table.userId, table.date),
  index("idx_hr_wellness_org_date").on(table.orgId, table.date),
  index("idx_hr_wellness_org_user").on(table.orgId, table.userId),
  index("idx_hr_wellness_org_user_membership").on(table.orgId, table.userMembershipId),
]);

export const hrSafetyIncidentsRelations = relations(hrSafetyIncidents, ({ one }) => ({
  org: one(organizations, { fields: [hrSafetyIncidents.orgId], references: [organizations.id] }),
  reporter: one(users, { fields: [hrSafetyIncidents.reportedBy], references: [users.id] }),
}));

export const hrWellnessCheckinsRelations = relations(hrWellnessCheckins, ({ one }) => ({
  org: one(organizations, { fields: [hrWellnessCheckins.orgId], references: [organizations.id] }),
  user: one(users, { fields: [hrWellnessCheckins.userId], references: [users.id] }),
}));
