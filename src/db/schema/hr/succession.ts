import { pgTable, text, serial, timestamp, integer, date, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { hrJobRoles } from "./core-org";
import { successionReadinessEnum } from "./performance";

export const hrRoleSkillRequirements = pgTable("hr_role_skill_requirements", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  jobRoleId: integer("job_role_id").references(() => hrJobRoles.id, { onDelete: "cascade" }),
  roleName: text("role_name"),
  skillName: text("skill_name").notNull(),
  requiredLevel: integer("required_level").default(3).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_role_skill_req_org").on(table.orgId),
  index("idx_role_skill_req_job_role").on(table.jobRoleId),
]);

export const hrMentorships = pgTable("hr_mentorships", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  mentorId: text("mentor_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  menteeId: text("mentee_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: text("status").default("active").notNull(),
  startedAt: date("started_at"),
  endedAt: date("ended_at"),
  goal: text("goal"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_mentorships_org").on(table.orgId),
  index("idx_mentorships_mentor").on(table.mentorId),
  index("idx_mentorships_mentee").on(table.menteeId),
]);

export const hrSuccessionPlans = pgTable("hr_succession_plans", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  roleName: text("role_name").notNull(),
  jobRoleId: integer("job_role_id").references(() => hrJobRoles.id, { onDelete: "set null" }),
  incumbentId: text("incumbent_id").references(() => users.id, { onDelete: "set null" }),
  successorId: text("successor_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  readiness: successionReadinessEnum("readiness").default("ready_now").notNull(),
  note: text("note"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_succession_org").on(table.orgId),
  index("idx_succession_role").on(table.orgId, table.jobRoleId),
]);

export const hrRoleSkillRequirementsRelations = relations(hrRoleSkillRequirements, ({ one }) => ({
  organization: one(organizations, { fields: [hrRoleSkillRequirements.orgId], references: [organizations.id] }),
  jobRole: one(hrJobRoles, { fields: [hrRoleSkillRequirements.jobRoleId], references: [hrJobRoles.id] }),
}));

export const hrMentorshipsRelations = relations(hrMentorships, ({ one }) => ({
  organization: one(organizations, { fields: [hrMentorships.orgId], references: [organizations.id] }),
  mentor: one(users, { fields: [hrMentorships.mentorId], references: [users.id], relationName: "mentorshipMentor" }),
  mentee: one(users, { fields: [hrMentorships.menteeId], references: [users.id], relationName: "mentorshipMentee" }),
}));

export const hrSuccessionPlansRelations = relations(hrSuccessionPlans, ({ one }) => ({
  organization: one(organizations, { fields: [hrSuccessionPlans.orgId], references: [organizations.id] }),
  jobRole: one(hrJobRoles, { fields: [hrSuccessionPlans.jobRoleId], references: [hrJobRoles.id] }),
  incumbent: one(users, { fields: [hrSuccessionPlans.incumbentId], references: [users.id], relationName: "successionIncumbent" }),
  successor: one(users, { fields: [hrSuccessionPlans.successorId], references: [users.id], relationName: "successionSuccessor" }),
  creator: one(users, { fields: [hrSuccessionPlans.createdBy], references: [users.id], relationName: "successionCreator" }),
}));
