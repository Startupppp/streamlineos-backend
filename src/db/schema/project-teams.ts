import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./auth";
import { projects } from "./projects/core";

export const projectTeams = pgTable(
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
    pmWorkspaceId: text("pm_workspace_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    uniqueIndex("uniq_project_teams_org_key").on(t.orgId, t.key),
    index("idx_project_teams_org").on(t.orgId),
    unique("uniq_project_teams_org_id").on(t.orgId, t.id),
  ],
);

export const projectTeamMembers = pgTable(
  "project_team_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    teamId: integer("team_id")
      .references(() => projectTeams.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_project_team_members_team_user").on(t.teamId, t.userId),
    index("idx_project_team_members_org").on(t.orgId),
    index("idx_project_team_members_user").on(t.userId),
    unique("uniq_project_team_members_org_id").on(t.orgId, t.id),
  ],
);

export const projectWorkspaceMembers = pgTable(
  "project_workspace_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").notNull().default("member"),
    pmWorkspaceId: text("pm_workspace_id"),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_project_workspace_members_org_user").on(
      t.orgId,
      t.userId,
    ),
    index("idx_project_workspace_members_org").on(t.orgId),
    unique("uniq_project_workspace_members_org_id").on(t.orgId, t.id),
  ],
);

export const projectTeamAssignments = pgTable(
  "project_team_assignments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    teamId: integer("team_id")
      .references(() => projectTeams.id, { onDelete: "cascade" })
      .notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_project_team_assignments_project_team").on(
      t.projectId,
      t.teamId,
    ),
    index("idx_project_team_assignments_org").on(t.orgId),
    index("idx_project_team_assignments_team").on(t.teamId),
    index("idx_project_team_assignments_project").on(t.projectId),
    unique("uniq_project_team_assignments_org_id").on(t.orgId, t.id),
  ],
);
