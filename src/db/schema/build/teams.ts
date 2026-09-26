import { text, integer, boolean, timestamp, index, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { sql } from "drizzle-orm";
import { organizations, organizationMembers } from "../common/auth";
import { projects } from "./core";

export const projectTeams = build.table(
  "project_teams",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    key: text("key").notNull(),
    icon: text("icon"),
    color: text("color"),
    isPrivate: boolean("is_private").notNull().default(false),
    capacity: integer("capacity"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    uniqueIndex("uniq_project_teams_org_key").on(t.orgId, t.key),
    index("idx_project_teams_org").on(t.orgId).where(sql`deleted_at IS NULL`),
    unique("uniq_project_teams_org_id").on(t.orgId, t.id),
  ],
);

export const projectTeamMembers = build.table(
  "project_team_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    teamId: integer("team_id")
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.teamId], foreignColumns: [projectTeams.orgId, projectTeams.id], name: "fk_project_team_members_org_team" }).onDelete("cascade"),
    uniqueIndex("uniq_project_team_members_team_user").on(t.teamId, t.membershipId),
    index("idx_project_team_members_org_membership").on(t.orgId, t.membershipId),
    unique("uniq_project_team_members_org_id").on(t.orgId, t.id),
    foreignKey({
      name: "fk_project_team_members_actor",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

export const buildMembers = build.table(
  "build_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    role: text("role").notNull().default("member"),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_build_members_org_membership").on(
      t.orgId,
      t.membershipId,
    ),
    unique("uniq_build_members_org_id").on(t.orgId, t.id),
    foreignKey({
      name: "fk_build_members_actor",
      columns: [t.orgId, t.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

export const projectTeamAssignments = build.table(
  "project_team_assignments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .notNull(),
    teamId: integer("team_id")
      .notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [
  foreignKey({ columns: [t.orgId, t.teamId], foreignColumns: [projectTeams.orgId, projectTeams.id], name: "fk_project_team_assignments_org_team" }).onDelete("cascade"),
  foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_team_assignments_org_project" }).onDelete("cascade"),
    uniqueIndex("uniq_project_team_assignments_project_team").on(
      t.projectId,
      t.teamId,
    ),
    index("idx_project_team_assignments_team").on(t.teamId),
    unique("uniq_project_team_assignments_org_id").on(t.orgId, t.id),
  ],
);
