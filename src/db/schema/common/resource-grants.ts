import { pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";

/** Record-level access, in one auditable place. */
export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),

    /** e.g. "kb_space", "whiteboard", "project". */
    resourceType: text("resource_type").notNull(),
    /** Stringified primary key of that resource. */
    resourceId: text("resource_id").notNull(),

    /** "user" | "org_membership" | "principal_group" | "role". */
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),

    /** e.g. "viewer", "editor", "admin". */
    level: text("level").notNull(),

    grantedBy: text("granted_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uniq_resource_grants_principal").on(
      t.orgId,
      t.resourceType,
      t.resourceId,
      t.principalType,
      t.principalId,
    ),
    // "who can see this record?"
    index("idx_resource_grants_resource").on(t.orgId, t.resourceType, t.resourceId),
    // "what can this principal see?" — the query the bespoke tables cannot answer
    index("idx_resource_grants_principal").on(t.orgId, t.principalType, t.principalId),
  ],
);

export const resourceGrantsRelations = relations(resourceGrants, ({ one }) => ({
  organization: one(organizations, {
    fields: [resourceGrants.orgId],
    references: [organizations.id],
  }),
  grantedByUser: one(users, {
    fields: [resourceGrants.grantedBy],
    references: [users.id],
  }),
}));
