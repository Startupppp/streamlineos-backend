import { randomUUID } from "node:crypto";
import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  decimal,
  date,
  integer,
  index,
  uniqueIndex,
  foreignKey,
  type AnyPgColumn,
  unique,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import {
  incentiveStatusEnum,
  taskEntityTypeEnum,
  taskStatusEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { orgUnits } from "../common/organization";
import { leads } from "./leads";
import {
  clients,
  clientAccounts,
  contacts,
  crmOrganizations,
} from "./contacts";
import { crmPipelines } from "./metadata";
import { crmPeople, crmSla } from "./analytics";

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
    value: decimal("value", { precision: 15, scale: 2 }).default("0").notNull(),
    stage: text("stage").default("LEAD").notNull(),
    probability: integer("probability").default(0).notNull(),
    contactPerson: text("contact_person"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    assignedToId: text("assigned_to_id").references(() => users.id, {
      onDelete: "set null",
    }),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_deal_activities_deal").on(table.dealId),
    index("idx_deal_activities_org").on(table.orgId),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_deal_meetings_deal").on(table.dealId),
    index("idx_deal_meetings_org").on(table.orgId),
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
    requestedStage: text("requested_stage").notNull(),
    status: text("status").default("pending").notNull(),
    approvedBy: text("approved_by").references(() => users.id),
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
    index("idx_crm_deal_competitors_org").on(table.orgId),
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
    data: jsonb("data").$type<ForecastSnapshotData>().notNull(),
    overrideAmount: decimal("override_amount", { precision: 15, scale: 4 }),
    overrideNote: text("override_note"),
    overriddenBy: text("overridden_by").references(() => users.id, {
      onDelete: "set null",
    }),
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
    index("idx_crm_deal_stakeholders_deal").on(table.orgId, table.dealId),
    index("idx_crm_deal_stakeholders_contact").on(table.orgId, table.contactId),
    unique("uniq_crm_deal_stakeholders_org_id").on(table.orgId, table.id),
  ],
);

export const salesQuotas = pgTable(
  "sales_quotas",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    period: text("period").default("monthly").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    targetRevenue: decimal("target_revenue", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    actualRevenue: decimal("actual_revenue", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    notes: text("notes"),
    setById: text("set_by_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_sales_quotas_org_user").on(table.orgId, table.userId),
    unique("uniq_sales_quotas_org_id").on(table.orgId, table.id),
  ],
);

export const commissionRules = pgTable(
  "commission_rules",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    type: text("type").default("flat_percent").notNull(),
    flatRate: decimal("flat_rate", { precision: 5, scale: 2 }),
    tiers:
      jsonb("tiers").$type<
        Array<{ minValue: number; maxValue?: number | null; rate: number }>
      >(),
    appliesTo: text("applies_to").default("all").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("uniq_commission_rules_org_id").on(t.orgId, t.id)],
);

export const commissions = pgTable(
  "commissions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    dealId: integer("deal_id")
      .references(() => deals.id, { onDelete: "cascade" })
      .notNull(),
    ruleId: integer("rule_id").references(() => commissionRules.id, {
      onDelete: "set null",
    }),
    dealValue: decimal("deal_value", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    commissionRate: decimal("commission_rate", { precision: 5, scale: 2 })
      .default("0")
      .notNull(),
    commissionAmount: decimal("commission_amount", { precision: 15, scale: 2 })
      .default("0")
      .notNull(),
    status: text("status").default("pending").notNull(),
    paidAt: timestamp("paid_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_commissions_org_user").on(table.orgId, table.userId),
    index("idx_commissions_deal").on(table.dealId),
    unique("uniq_commissions_org_id").on(table.orgId, table.id),
  ],
);

export const incentiveConfig = pgTable(
  "incentive_config",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    branchId: text("branch_id").references(() => orgUnits.id, { onDelete: "set null" }),
    incentiveRate: decimal("incentive_rate", {
      precision: 5,
      scale: 2,
    }).notNull(),
    effectiveFrom: timestamp("effective_from").defaultNow().notNull(),
    effectiveTo: timestamp("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("uniq_incentive_config_org_id").on(t.orgId, t.id)],
);

export const incentives = pgTable(
  "incentives",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    branchId: text("branch_id").references(() => orgUnits.id, { onDelete: "set null" }),
    clientAccountId: integer("client_account_id")
      .notNull()
      .references(() => clientAccounts.id),
    salesRepId: text("sales_rep_id")
      .notNull()
      .references(() => users.id),
    investmentAmount: decimal("investment_amount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    incentiveRate: decimal("incentive_rate", {
      precision: 5,
      scale: 2,
    }).notNull(),
    calculatedAmount: decimal("calculated_amount", {
      precision: 15,
      scale: 2,
    }).notNull(),
    approvedAmount: decimal("approved_amount", { precision: 15, scale: 2 }),
    status: incentiveStatusEnum("status").notNull().default("PENDING"),
    approvedBy: text("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_incentives_org").on(table.orgId),
    index("idx_incentives_sales_rep").on(table.salesRepId),
    index("idx_incentives_status").on(table.status),
    unique("uniq_incentives_org_id").on(table.orgId, table.id),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    title: text("title").notNull(),
    notes: text("notes"),
    entityType: taskEntityTypeEnum("entity_type"),
    entityId: integer("entity_id"),
    type: text("type").notNull().default("CUSTOM"),
    status: taskStatusEnum("status").notNull().default("pending"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    assigneeId: text("assignee_id").references(() => users.id),
    createdBy: text("created_by").references(() => users.id),
    dueDate: timestamp("due_date", { withTimezone: true }),
    remindAt: timestamp("remind_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    timezone: text("timezone"),
    recurrence: jsonb("recurrence").$type<{
      frequency: "DAILY" | "WEEKLY" | "MONTHLY";
      interval: number;
      endDate?: string;
    } | null>(),
    parentTaskId: integer("parent_task_id").references(
      (): AnyPgColumn => tasks.id,
      { onDelete: "set null" },
    ),
    isTemplate: boolean("is_template").notNull().default(false),
    templateName: text("template_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_tasks_org").on(table.orgId),
    index("idx_tasks_assignee").on(table.assigneeId),
    index("idx_tasks_status").on(table.status),
    index("idx_tasks_due_date").on(table.dueDate),
    index("idx_tasks_entity").on(table.entityType, table.entityId),
    index("idx_tasks_parent").on(table.parentTaskId),
    unique("uniq_tasks_org_id").on(table.orgId, table.id),
  ],
);

export const taskSequences = pgTable(
  "task_sequences",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [unique("uniq_task_sequences_org_id").on(t.orgId, t.id)],
);

export const taskSequenceSteps = pgTable("task_sequence_steps", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id")
    .notNull()
    .references(() => taskSequences.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  type: text("type").notNull().default("CUSTOM"),
  notes: text("notes"),
  offsetDays: integer("offset_days").notNull().default(0),
  order: integer("order").notNull().default(0),
});

export interface TerritoryCriteria {
  countries?: string[];
  states?: string[];
  cities?: string[];
  postalCodes?: string[];
  industries?: string[];
  companySizes?: string[];
  productKeys?: string[];
  accountTypes?: string[];
}

export const territories = pgTable(
  "territories",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").default(true).notNull(),
    criteria: jsonb("criteria")
      .$type<TerritoryCriteria>()
      .default({})
      .notNull(),
    priority: integer("priority").default(0).notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("territories_org_id_idx").on(table.orgId),
    unique("uniq_territories_org_id").on(table.orgId, table.id),
    index("idx_territories_org_live")
      .on(table.orgId, table.priority)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const territoryReps = pgTable(
  "territory_reps",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    territoryId: integer("territory_id").notNull(),
    crmPersonId: integer("crm_person_id")
      .references(() => crmPeople.id, { onDelete: "cascade" })
      .notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uniq_territory_reps_territory_person").on(
      table.territoryId,
      table.crmPersonId,
    ),
    index("idx_territory_reps_org").on(table.orgId),
    index("idx_territory_reps_territory").on(table.territoryId),
    foreignKey({
      columns: [table.orgId, table.territoryId],
      foreignColumns: [territories.orgId, territories.id],
    }).onDelete("cascade"),
    unique("uniq_territory_reps_org_id").on(table.orgId, table.id),
  ],
);

export const territoryLocations = pgTable(
  "territory_locations",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    territoryId: integer("territory_id").notNull(),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    uniqueIndex("uniq_territory_locations_territory_kind_value").on(
      table.territoryId,
      table.kind,
      table.value,
    ),
    index("idx_territory_locations_org").on(table.orgId),
    index("idx_territory_locations_territory").on(table.territoryId),
    foreignKey({
      columns: [table.orgId, table.territoryId],
      foreignColumns: [territories.orgId, territories.id],
    }).onDelete("cascade"),
  ],
);

export const crmSlaBreachLog = pgTable(
  "crm_sla_breach_log",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id").notNull(),
    leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    policyId: integer("policy_id").references(() => crmSla.id, {
      onDelete: "set null",
    }),
    breachedAt: timestamp("breached_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    taskCreated: boolean("task_created").default(false).notNull(),
    notified: boolean("notified").default(false).notNull(),
  },
  (table) => [
    uniqueIndex("crm_sla_breach_log_lead_policy_unique").on(
      table.leadId,
      table.policyId,
    ),
    index("idx_sla_breach_org_idx").on(table.orgId),
    index("idx_sla_breach_lead_idx").on(table.leadId),
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

export const incentivesRelations = relations(incentives, ({ one }) => ({
  organization: one(organizations, {
    fields: [incentives.orgId],
    references: [organizations.id],
  }),
  clientAccount: one(clientAccounts, {
    fields: [incentives.clientAccountId],
    references: [clientAccounts.id],
  }),
  salesRep: one(users, {
    fields: [incentives.salesRepId],
    references: [users.id],
  }),
  approver: one(users, {
    fields: [incentives.approvedBy],
    references: [users.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  organization: one(organizations, {
    fields: [tasks.orgId],
    references: [organizations.id],
  }),
  assignee: one(users, {
    fields: [tasks.assigneeId],
    references: [users.id],
    relationName: "taskAssignee",
  }),
  createdByUser: one(users, {
    fields: [tasks.createdBy],
    references: [users.id],
    relationName: "taskCreator",
  }),
  parentTask: one(tasks, {
    fields: [tasks.parentTaskId],
    references: [tasks.id],
    relationName: "childTasks",
  }),
}));

export const taskSequencesRelations = relations(
  taskSequences,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [taskSequences.orgId],
      references: [organizations.id],
    }),
    creator: one(users, {
      fields: [taskSequences.createdBy],
      references: [users.id],
    }),
    steps: many(taskSequenceSteps),
  }),
);

export const taskSequenceStepsRelations = relations(
  taskSequenceSteps,
  ({ one }) => ({
    sequence: one(taskSequences, {
      fields: [taskSequenceSteps.sequenceId],
      references: [taskSequences.id],
    }),
  }),
);

export const territoriesRelations = relations(territories, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [territories.orgId],
    references: [organizations.id],
  }),
  creator: one(users, {
    fields: [territories.createdBy],
    references: [users.id],
  }),
  reps: many(territoryReps),
  locations: many(territoryLocations),
}));

export const territoryRepsRelations = relations(territoryReps, ({ one }) => ({
  territory: one(territories, {
    fields: [territoryReps.orgId, territoryReps.territoryId],
    references: [territories.orgId, territories.id],
  }),
  crmPerson: one(crmPeople, {
    fields: [territoryReps.crmPersonId],
    references: [crmPeople.id],
  }),
}));

export const territoryLocationsRelations = relations(
  territoryLocations,
  ({ one }) => ({
    territory: one(territories, {
      fields: [territoryLocations.orgId, territoryLocations.territoryId],
      references: [territories.orgId, territories.id],
    }),
  }),
);

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
