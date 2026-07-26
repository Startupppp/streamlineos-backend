import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizations, organizationMembers } from "../auth";
import { pmWorkspaces } from "./pm-workspaces";

/**
 * PM Workspace Membership — references an active Organization Membership (never a raw User
 * Account). Product Management module permission + an active PM Workspace Membership is the
 * mandatory entry boundary for all PM Workspace / Managed Product / Delivery Team / Project work.
 */
export const pmWorkspaceMemberships = pgTable(
  "pm_workspace_memberships",
  {
    pmWorkspaceMembershipId: text("pm_workspace_membership_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    pmWorkspaceId: text("pm_workspace_id").notNull(),
    organizationMembershipId: integer("organization_membership_id").notNull(),
    role: text("role")
      .$type<"member" | "admin">()
      .default("member")
      .notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_pm_ws_members_org_ws_member").on(
      t.orgId,
      t.pmWorkspaceId,
      t.organizationMembershipId,
    ),
    index("idx_pm_ws_members_org_ws").on(t.orgId, t.pmWorkspaceId),
    index("idx_pm_ws_members_membership").on(t.organizationMembershipId),
    foreignKey({
      columns: [t.orgId, t.pmWorkspaceId],
      foreignColumns: [pmWorkspaces.orgId, pmWorkspaces.pmWorkspaceId],
      name: "fk_pm_ws_members_org_workspace",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.organizationMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_pm_ws_members_org_membership",
    }).onDelete("cascade"),
  ],
);
