import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./auth";

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
  ],
);
