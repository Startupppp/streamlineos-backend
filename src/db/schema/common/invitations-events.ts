import { pgTable, text, integer, timestamp, index, uuid } from "drizzle-orm/pg-core";
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
      .references(() => invitations.id, { onDelete: "cascade" })
      .notNull(),
    event: text("event").$type<InvitationEventType>().notNull(),
    actorMembershipId: integer("actor_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_invitation_events_org_invitation").on(table.orgId, table.invitationId),
  ],
);
