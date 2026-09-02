import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import { organizations } from "../common/auth";
import { partyContacts } from "../party/party-contacts";
import { portalGrantStatusEnum } from "../common/enums";
import { portalMemberships } from "./portal-memberships";
import { projects } from "../build";

export const projectClientGrants = pgTable(
  "project_client_grants",
  {
    projectClientGrantId: text("project_client_grant_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    portalMembershipId: text("portal_membership_id").notNull(),
    partyContactId: text("party_contact_id").notNull(),
    projectId: integer("project_id").notNull(),
    pmWorkspaceId: text("pm_workspace_id"),
    canViewMilestones: boolean("can_view_milestones").notNull().default(false),
    canViewTasks: boolean("can_view_tasks").notNull().default(false),
    canViewAttachments: boolean("can_view_attachments").notNull().default(false),
    canViewComments: boolean("can_view_comments").notNull().default(false),
    canSubmitChangeRequests: boolean("can_submit_change_requests").notNull().default(false),
    status: portalGrantStatusEnum("status").notNull().default("ACTIVE"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_project_client_grants_membership").on(
      table.organizationId,
      table.portalMembershipId,
    ),
    index("idx_project_client_grants_project").on(
      table.organizationId,
      table.projectId,
    ),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: "fk_project_client_grants_project_id_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.organizationId,
        table.portalMembershipId,
        table.partyContactId,
      ],
      foreignColumns: [
        portalMemberships.organizationId,
        portalMemberships.portalMembershipId,
        portalMemberships.partyContactId,
      ],
      name: "fk_project_client_grants_org_membership_contact",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.partyContactId],
      foreignColumns: [
        partyContacts.organizationId,
        partyContacts.partyContactId,
      ],
      name: "fk_project_client_grants_org_contact",
    }).onDelete("restrict"),
  ],
);
