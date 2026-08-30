import { pgTable, text, serial, timestamp, boolean, integer, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users, organizationMembers } from "./auth";

export const calendarEvents = pgTable("calendar_events", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
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
  createdBy: text("created_by").references(() => users.id).notNull(),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_calendar_events_org_date").on(table.orgId, table.startDate),
  index("idx_calendar_events_category").on(table.category),
  index("idx_calendar_events_created_by").on(table.createdBy),
  index("idx_calendar_events_org_created_by_membership").on(table.orgId, table.createdByMembershipId),
  index("idx_calendar_events_external").on(table.integrationConnectionId, table.externalEventId),
  unique("uniq_calendar_events_org_id").on(table.orgId, table.id),
  foreignKey({
    columns: [table.orgId, table.createdByMembershipId],
    foreignColumns: [organizationMembers.orgId, organizationMembers.id],
    name: "fk_calendar_events_org_creator_membership",
  }),
]);

export const eventAttendees = pgTable("event_attendees", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  eventId: integer("event_id").references(() => calendarEvents.id, { onDelete: "cascade" }).notNull(),
  membershipId: integer("membership_id").references(() => organizationMembers.id, { onDelete: "restrict" }).notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("event_attendees_event_membership_unique").on(table.orgId, table.eventId, table.membershipId),
  index("idx_event_attendees_event_id").on(table.orgId, table.eventId),
  index("idx_event_attendees_membership_id").on(table.orgId, table.membershipId),
  foreignKey({ columns: [table.orgId, table.eventId], foreignColumns: [calendarEvents.orgId, calendarEvents.id], name: "fk_event_attendees_org_event" }),
  foreignKey({ columns: [table.orgId, table.membershipId], foreignColumns: [organizationMembers.orgId, organizationMembers.id], name: "fk_event_attendees_org_membership" }),
]);

export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  organization: one(organizations, { fields: [calendarEvents.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [calendarEvents.createdBy], references: [users.id] }),
  creatorMembership: one(organizationMembers, { fields: [calendarEvents.orgId, calendarEvents.createdByMembershipId], references: [organizationMembers.orgId, organizationMembers.id] }),
  attendees: many(eventAttendees),
}));

export const eventAttendeesRelations = relations(eventAttendees, ({ one }) => ({
  event: one(calendarEvents, { fields: [eventAttendees.eventId], references: [calendarEvents.id] }),
  membership: one(organizationMembers, { fields: [eventAttendees.membershipId], references: [organizationMembers.id] }),
}));
