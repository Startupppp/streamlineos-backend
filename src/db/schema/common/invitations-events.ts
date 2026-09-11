import { foreignKey, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { invitations, organizations } from "./auth";

export type InvitationEventType =
  | "CREATED"
  | "RESENT"
  | "ACCEPTED"
  | "DECLINED"
  | "REVOKED"
  | "EXPIRED"
  | "ROLE_CHANGED"
  | "DELIVERY_FAILED";

export const invitationEvents = pgTable(
  "invitation_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    invitationId: text("invitation_id")
      .notNull(),
    event: text("event").$type<InvitationEventType>().notNull(),
    actorMembershipId: integer("actor_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
  foreignKey({ columns: [table.orgId, table.invitationId], foreignColumns: [invitations.orgId, invitations.id], name: "fk_invitation_events_invitation_id_org" }).onDelete("cascade"),
    index("idx_invitation_events_org_invitation").on(table.orgId, table.invitationId),
  ],
);
