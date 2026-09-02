import { foreignKey, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { hrJobRoles } from "./core-org";
import { successionReadinessEnum } from "./performance";

export const hrRoleSkillRequirements = pgTable("hr_role_skill_requirements", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  jobRoleId: integer("job_role_id"),
  roleName: text("role_name"),
  skillName: text("skill_name").notNull(),
  requiredLevel: integer("required_level").default(3).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.jobRoleId], foreignColumns: [hrJobRoles.orgId, hrJobRoles.id], name: "fk_hr_role_skill_requirements_org_job_role" }).onDelete("cascade"),
  unique("uniq_hr_role_skill_requirements_org_id").on(table.orgId, table.id),
  index("idx_role_skill_req_job_role").on(table.jobRoleId),
]);

export const hrSuccessionPlans = pgTable("hr_succession_plans", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  roleName: text("role_name").notNull(),
  jobRoleId: integer("job_role_id"),
  incumbentId: text("incumbent_id").references(() => users.id, { onDelete: "set null" }),
  successorId: text("successor_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  readiness: successionReadinessEnum("readiness").default("ready_now").notNull(),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.jobRoleId], foreignColumns: [hrJobRoles.orgId, hrJobRoles.id], name: "fk_hr_succession_plans_org_job_role" }).onDelete("set null"),
  unique("uniq_hr_succession_plans_org_id").on(table.orgId, table.id),
  index("idx_succession_role").on(table.orgId, table.jobRoleId),
]);

export const hrRoleSkillRequirementsRelations = relations(hrRoleSkillRequirements, ({ one }) => ({
  organization: one(organizations, { fields: [hrRoleSkillRequirements.orgId], references: [organizations.id] }),
  jobRole: one(hrJobRoles, { fields: [hrRoleSkillRequirements.jobRoleId], references: [hrJobRoles.id] }),
}));

export const hrSuccessionPlansRelations = relations(hrSuccessionPlans, ({ one }) => ({
  organization: one(organizations, { fields: [hrSuccessionPlans.orgId], references: [organizations.id] }),
  jobRole: one(hrJobRoles, { fields: [hrSuccessionPlans.jobRoleId], references: [hrJobRoles.id] }),
  incumbent: one(users, { fields: [hrSuccessionPlans.incumbentId], references: [users.id], relationName: "successionIncumbent" }),
  successor: one(users, { fields: [hrSuccessionPlans.successorId], references: [users.id], relationName: "successionSuccessor" }),
  creator: one(users, { fields: [hrSuccessionPlans.createdBy], references: [users.id], relationName: "successionCreator" }),
}));
