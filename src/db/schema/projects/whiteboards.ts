import {
  pgTable,
  pgEnum,
  text,
  serial,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
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

export const projectWhiteboards = pgTable(
  "project_whiteboards",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    projectId: integer("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    data: jsonb("data").$type<ExcalidrawSceneData>().default({ elements: [] }).notNull(),
    visibility: whiteboardVisibilityEnum("visibility").default("project").notNull(),
    publicAccess: whiteboardShareRoleEnum("public_access").default("viewer").notNull(),
    shareToken: text("share_token"),
    linkExpiresAt: timestamp("link_expires_at"),
    allowExport: boolean("allow_export").default(true).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_project_whiteboards_org_project").on(table.orgId, table.projectId),
    uniqueIndex("uniq_project_whiteboards_share_token").on(table.shareToken),
  ],
);

export const projectWhiteboardShares = pgTable(
  "project_whiteboard_shares",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    whiteboardId: integer("whiteboard_id")
      .references(() => projectWhiteboards.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    role: whiteboardShareRoleEnum("role").notNull().default("viewer"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uniq_whiteboard_shares_board_user").on(table.whiteboardId, table.userId),
    index("idx_whiteboard_shares_org_board").on(table.orgId, table.whiteboardId),
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
  user: one(users, { fields: [projectWhiteboardShares.userId], references: [users.id] }),
}));
