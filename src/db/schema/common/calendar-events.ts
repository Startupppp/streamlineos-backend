import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  integer,
  index,
  unique,
  foreignKey,
  jsonb,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, organizationMembers } from "./auth";

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    meetingUrl: text("meeting_url"),
    startDate: timestamp("start_date", { withTimezone: true }).notNull(),
    endDate: timestamp("end_date", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    allDay: boolean("all_day").default(false).notNull(),
    color: text("color"),
    category: text("category").notNull(),
    visibility: text("visibility").notNull().default("org"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    createdByMembershipId: integer("created_by_membership_id").notNull(),
    agenda: text("agenda"),
    postMeetingNotes: text("post_meeting_notes"),
    linkedDealId: integer("linked_deal_id"),
    linkedLeadId: integer("linked_lead_id"),
    rrule: text("rrule"),
    recurrenceEnd: timestamp("recurrence_end", { withTimezone: true }),
    reminder15MinSent: boolean("reminder_15min_sent").default(false).notNull(),
    integrationConnectionId: integer("integration_connection_id"),
    externalEventId: text("external_event_id"),
    localVersion: integer("local_version").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_calendar_events_org_date").on(table.orgId, table.startDate),
    index("idx_calendar_events_category").on(table.category),
    index("idx_calendar_events_org_created_by_membership").on(
      table.orgId,
      table.createdByMembershipId,
    ),
    index("idx_calendar_events_external").on(
      table.integrationConnectionId,
      table.externalEventId,
    ),
    unique("uniq_calendar_events_org_id").on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.createdByMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_calendar_events_org_creator_membership",
    }),
  ],
);

export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    eventId: integer("event_id").notNull(),
    membershipId: integer("membership_id").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("event_attendees_event_membership_unique").on(
      table.orgId,
      table.eventId,
      table.membershipId,
    ),
    index("idx_event_attendees_membership_id").on(
      table.orgId,
      table.membershipId,
    ),
    foreignKey({
      columns: [table.orgId, table.eventId],
      foreignColumns: [calendarEvents.orgId, calendarEvents.id],
      name: "fk_event_attendees_org_event",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.orgId, table.membershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_event_attendees_org_membership",
    }).onDelete("cascade"),
  ],
);

export const calendarEventsRelations = relations(
  calendarEvents,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [calendarEvents.orgId],
      references: [organizations.id],
    }),
    creatorMembership: one(organizationMembers, {
      fields: [calendarEvents.orgId, calendarEvents.createdByMembershipId],
      references: [organizationMembers.orgId, organizationMembers.id],
    }),
    attendees: many(eventAttendees),
  }),
);

export const eventAttendeesRelations = relations(eventAttendees, ({ one }) => ({
  event: one(calendarEvents, {
    fields: [eventAttendees.eventId],
    references: [calendarEvents.id],
  }),
  membership: one(organizationMembers, {
    fields: [eventAttendees.membershipId],
    references: [organizationMembers.id],
  }),
}));

export const calendarProviderSyncQueue = pgTable(
  "calendar_provider_sync_queue",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
    eventId: integer("event_id"),
    connectionId: integer("connection_id").notNull(),
    operation: text("operation").$type<"create" | "update" | "delete">().notNull(),
    externalEventId: text("external_event_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    state: text("state").$type<"PENDING" | "IN_FLIGHT" | "PROCESSED" | "FAILED">().default("PENDING").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    eventLocalVersion: integer("event_local_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_cal_provider_sync_queue_pending")
      .on(table.state, table.id)
      .where(sql`state IN ('PENDING','IN_FLIGHT')`),
    index("idx_cal_provider_sync_queue_org").on(table.orgId, table.state),
  ],
);
