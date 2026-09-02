import { randomUUID } from "node:crypto";
import { bigint, boolean, date, decimal, foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { organizations, users } from "../common/auth";
import { leads } from "./leads";
import {
  clients,
  contacts,
  crmOrganizations,
} from "./contacts";
import { crmPipelines } from "./metadata";

export const deals = pgTable(
  "deals",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    leadId: integer("lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    clientId: integer("client_id").references(() => clients.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    valueMinor: bigint("value_minor", { mode: "number" }).default(0).notNull(),
    value: decimal("value", { precision: 15, scale: 2 })
      .generatedAlwaysAs(sql`(value_minor::numeric / 100)`)
      .notNull(),
    stage: text("stage").default("LEAD").notNull(),
    partyId: text("party_id"),
    subjectId: text("subject_id"),
    probability: integer("probability").default(0).notNull(),
    contactPerson: text("contact_person"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    assignedToId: text("assigned_to_id").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedToMembershipId: integer("assigned_to_membership_id"),
    lastContactDate: timestamp("last_contact_date"),
    expectedCloseDate: date("expected_close_date"),
    actualCloseDate: date("actual_close_date"),
    lostReason: text("lost_reason"),
    notes: text("notes"),
    slaDeadline: timestamp("sla_deadline"),
    followUpDate: timestamp("follow_up_date"),
    followUpNotes: text("follow_up_notes"),
    pipelineId: text("pipeline_id").references(() => crmPipelines.id, {
      onDelete: "set null",
    }),
    forecastCategory: text("forecast_category"),
    nextStep: text("next_step"),
    healthScore: integer("health_score"),
    customData: jsonb("custom_data").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_deals_org_live_stage")
      .on(table.orgId, table.stage)
      .where(sql`${table.deletedAt} IS NULL`),
    index("idx_deals_org_stage_assignee").on(
      table.orgId,
      table.stage,
      table.assignedToId,
    ),
    index("idx_deals_client").on(table.clientId),
    index("idx_deals_lead").on(table.leadId),
    index("idx_deals_close_date").on(table.expectedCloseDate),
    index("idx_deals_org_pipeline_stage").on(
      table.orgId,
      table.pipelineId,
      table.stage,
    ),
    unique("uniq_deals_org_id").on(table.orgId, table.id),
    index("idx_deals_org_party")
      .on(table.orgId, table.partyId)
      .where(sql`deleted_at is null`),
    index("idx_deals_org_subject")
      .on(table.orgId, table.subjectId)
      .where(sql`deleted_at is null`),
  ],
);

export const dealActivities = pgTable(
  "deal_activities",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    type: text("type").notNull(),
    previousValue: text("previous_value"),
    newValue: text("new_value"),
    subject: text("subject"),
    notes: text("notes"),
    duration: integer("duration"),
    userId: text("user_id")
      .references(() => users.id)
      .notNull(),
    userMembershipId: integer("user_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_deal_activities_deal").on(table.dealId),
    unique("uniq_deal_activities_org_id").on(table.orgId, table.id),
  ],
);

export const dealMeetings = pgTable(
  "deal_meetings",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    scheduledAt: timestamp("scheduled_at").notNull(),
    durationMinutes: integer("duration_minutes").default(30).notNull(),
    agenda: text("agenda"),
    notes: text("notes"),
    actionItems: text("action_items"),
    recordingLink: text("recording_link"),
    status: text("status").default("scheduled").notNull(),
    createdBy: text("created_by")
      .references(() => users.id)
      .notNull(),
    createdByMembershipId: integer("created_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_deal_meetings_deal").on(table.dealId),
    unique("uniq_deal_meetings_org_id").on(table.orgId, table.id),
  ],
);

export const dealMeetingAttendees = pgTable(
  "deal_meeting_attendees",
  {
    id: serial("id").primaryKey(),
    meetingId: integer("meeting_id")
      .references(() => dealMeetings.id, { onDelete: "cascade" })
      .notNull(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    attendeeId: text("attendee_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_deal_meeting_attendees_unique").on(
      table.meetingId,
      table.attendeeId,
    ),
    unique("uniq_deal_meeting_attendees_org_id").on(table.orgId, table.id),
  ],
);

export const dealApprovalRules = pgTable(
  "deal_approval_rules",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    minValue: decimal("min_value", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    approverRole: text("approver_role"),
    approverType: text("approver_type").default("role").notNull(),
    approverUserId: text("approver_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approverMembershipId: integer("approver_membership_id"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("uniq_deal_approval_rules_org_id").on(t.orgId, t.id)],
);

export const dealApprovals = pgTable(
  "deal_approvals",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id")
      .references(() => deals.id)
      .notNull(),
    requestedBy: text("requested_by")
      .references(() => users.id)
      .notNull(),
    requestedByMembershipId: integer("requested_by_membership_id"),
    requestedStage: text("requested_stage").notNull(),
    status: text("status").default("pending").notNull(),
    approvedBy: text("approved_by").references(() => users.id),
    approvedByMembershipId: integer("approved_by_membership_id"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => [
    index("idx_deal_approvals_org").on(table.orgId, table.status),
    index("idx_deal_approvals_deal").on(table.dealId),
    unique("uniq_deal_approvals_org_id").on(table.orgId, table.id),
  ],
);

export const crmDealCompetitors = pgTable(
  "crm_deal_competitors",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    competitorKey: text("competitor_key").notNull(),
    status: text("status").default("active").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_crm_deal_competitors_deal_key").on(
      table.orgId,
      table.dealId,
      table.competitorKey,
    ),
    index("idx_crm_deal_competitors_deal").on(table.dealId),
    unique("uniq_crm_deal_competitors_org_id").on(table.orgId, table.id),
  ],
);

export interface ForecastSnapshotData {
  byCategory: Array<{
    category: string;
    totalValue: number;
    weightedValue: number;
    dealCount: number;
  }>;
  byRep: Array<{
    repId: string;
    repName: string;
    totalValue: number;
    weightedValue: number;
    dealCount: number;
  }>;
  totalWeighted: number;
  totalBestCase: number;
  totalDeals: number;
  period: string;
}

export const crmForecastSnapshots = pgTable(
  "crm_forecast_snapshots",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    period: text("period").notNull(),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
    createdById: text("created_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByMembershipId: integer("created_by_membership_id"),
    data: jsonb("data").$type<ForecastSnapshotData>().notNull(),
    overrideAmount: decimal("override_amount", { precision: 15, scale: 4 }),
    overrideNote: text("override_note"),
    overriddenBy: text("overridden_by").references(() => users.id, {
      onDelete: "set null",
    }),
    overriddenByMembershipId: integer("overridden_by_membership_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_crm_forecast_snapshots_org_period").on(
      table.orgId,
      table.period,
      table.capturedAt,
    ),
    unique("uniq_crm_forecast_snapshots_org_id").on(table.orgId, table.id),
  ],
);

export const crmDealStakeholders = pgTable(
  "crm_deal_stakeholders",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    contactId: integer("contact_id")
      .references(() => contacts.id, { onDelete: "cascade" })
      .notNull(),
    roleKey: text("role_key"),
    influence: text("influence"),
    isPrimary: boolean("is_primary").default(false).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_crm_deal_stakeholders_deal_contact").on(
      table.orgId,
      table.dealId,
      table.contactId,
    ),
    index("idx_crm_deal_stakeholders_contact").on(table.orgId, table.contactId),
    unique("uniq_crm_deal_stakeholders_org_id").on(table.orgId, table.id),
  ],
);

export const contactsRelations = relations(contacts, ({ one }) => ({
  organization: one(organizations, {
    fields: [contacts.orgId],
    references: [organizations.id],
  }),
  crmOrganization: one(crmOrganizations, {
    fields: [contacts.organizationId],
    references: [crmOrganizations.id],
  }),
  lead: one(leads, { fields: [contacts.leadId], references: [leads.id] }),
  deal: one(deals, { fields: [contacts.dealId], references: [deals.id] }),
}));

export const dealsRelations = relations(deals, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [deals.orgId],
    references: [organizations.id],
  }),
  lead: one(leads, { fields: [deals.leadId], references: [leads.id] }),
  client: one(clients, { fields: [deals.clientId], references: [clients.id] }),
  assignedTo: one(users, {
    fields: [deals.assignedToId],
    references: [users.id],
  }),
  activities: many(dealActivities),
  meetings: many(dealMeetings),
  competitors: many(crmDealCompetitors),
  stakeholders: many(crmDealStakeholders),
}));

export const dealMeetingsRelations = relations(
  dealMeetings,
  ({ one, many }) => ({
    deal: one(deals, { fields: [dealMeetings.dealId], references: [deals.id] }),
    creator: one(users, {
      fields: [dealMeetings.createdBy],
      references: [users.id],
    }),
    attendeeRows: many(dealMeetingAttendees),
  }),
);

export const dealMeetingAttendeesRelations = relations(
  dealMeetingAttendees,
  ({ one }) => ({
    meeting: one(dealMeetings, {
      fields: [dealMeetingAttendees.meetingId],
      references: [dealMeetings.id],
    }),
  }),
);

export const dealActivitiesRelations = relations(dealActivities, ({ one }) => ({
  deal: one(deals, { fields: [dealActivities.dealId], references: [deals.id] }),
  user: one(users, { fields: [dealActivities.userId], references: [users.id] }),
}));

export const crmDealCompetitorsRelations = relations(
  crmDealCompetitors,
  ({ one }) => ({
    deal: one(deals, {
      fields: [crmDealCompetitors.dealId],
      references: [deals.id],
    }),
    organization: one(organizations, {
      fields: [crmDealCompetitors.orgId],
      references: [organizations.id],
    }),
  }),
);

export const crmDealStakeholdersRelations = relations(
  crmDealStakeholders,
  ({ one }) => ({
    deal: one(deals, {
      fields: [crmDealStakeholders.dealId],
      references: [deals.id],
    }),
    contact: one(contacts, {
      fields: [crmDealStakeholders.contactId],
      references: [contacts.id],
    }),
    organization: one(organizations, {
      fields: [crmDealStakeholders.orgId],
      references: [organizations.id],
    }),
  }),
);

export const crmForecastSnapshotsRelations = relations(
  crmForecastSnapshots,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [crmForecastSnapshots.orgId],
      references: [organizations.id],
    }),
    createdBy: one(users, {
      fields: [crmForecastSnapshots.createdById],
      references: [users.id],
    }),
  }),
);
