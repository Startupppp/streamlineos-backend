import {
  pgEnum,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  unique,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { relations, sql } from "drizzle-orm";
import { organizations, users, organizationMembers } from "../common/auth";
import { projects } from "./core";

export type ExcalidrawSceneData = {
  type?: string;
  version?: number;
  source?: string;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

export const whiteboardVisibilityEnum = pgEnum("whiteboard_visibility", [
  "project",
  "private",
  "public",
]);
export const whiteboardShareRoleEnum = pgEnum("whiteboard_share_role", ["viewer", "editor"]);

export const projectWhiteboards = build.table(
  "project_whiteboards",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .notNull(),
    name: text("name").notNull(),
    data: jsonb("data").$type<ExcalidrawSceneData>().default({ elements: [] }).notNull(),
    visibility: whiteboardVisibilityEnum("visibility").default("project").notNull(),
    publicAccess: whiteboardShareRoleEnum("public_access").default("viewer").notNull(),
    shareToken: text("share_token"),
    linkExpiresAt: timestamp("link_expires_at"),
    allowExport: boolean("allow_export").default(true).notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id], name: "fk_project_whiteboards_org_project" }).onDelete("cascade"),
    index("idx_project_whiteboards_org_project").on(table.orgId, table.projectId).where(sql`deleted_at IS NULL`),
    uniqueIndex("uniq_project_whiteboards_share_token").on(table.shareToken),
    unique("uniq_project_whiteboards_org_id").on(table.orgId, table.id),
  ],
);

export const projectWhiteboardShares = build.table(
  "project_whiteboard_shares",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    whiteboardId: integer("whiteboard_id")
      .notNull(),
    membershipId: integer("membership_id").notNull(),
    role: whiteboardShareRoleEnum("role").notNull().default("viewer"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.whiteboardId], foreignColumns: [projectWhiteboards.orgId, projectWhiteboards.id], name: "fk_project_whiteboard_shares_org_board" }).onDelete("cascade"),
    uniqueIndex("uniq_whiteboard_shares_board_user").on(table.whiteboardId, table.membershipId),
    index("idx_whiteboard_shares_org_board").on(table.orgId, table.whiteboardId),
    index("idx_whiteboard_shares_org_membership").on(table.orgId, table.membershipId),
    unique("uniq_project_whiteboard_shares_org_id").on(table.orgId, table.id),
    foreignKey({
      name: "fk_whiteboard_shares_actor",
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    }).onDelete("cascade"),
  ],
);

export const projectWhiteboardsRelations = relations(projectWhiteboards, ({ one, many }) => ({
  project: one(projects, { fields: [projectWhiteboards.projectId], references: [projects.id] }),
  shares: many(projectWhiteboardShares),
}));

export const projectWhiteboardSharesRelations = relations(projectWhiteboardShares, ({ one }) => ({
  whiteboard: one(projectWhiteboards, {
    fields: [projectWhiteboardShares.whiteboardId],
    references: [projectWhiteboards.id],
  }),
}));
