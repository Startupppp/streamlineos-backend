import { date, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../common/auth";

export const hrAccommodationTypeEnum = pgEnum("hr_accommodation_type", [
  "equipment",
  "schedule",
  "workspace",
  "medical_restriction",
  "other",
]);

export const hrAccommodationStatusEnum = pgEnum("hr_accommodation_status", [
  "requested",
  "under_review",
  "approved",
  "denied",
  "implemented",
]);

export const hrAccommodationTaskStatusEnum = pgEnum("hr_accommodation_task_status", [
  "pending",
  "in_progress",
  "completed",
]);

export const hrEmergencyEventTypeEnum = pgEnum("hr_emergency_event_type", [
  "office_closure",
  "disaster",
  "safety_check",
  "other",
]);

export const hrEmergencyEventStatusEnum = pgEnum("hr_emergency_event_status", [
  "active",
  "resolved",
]);

export const hrEmergencyResponseStatusEnum = pgEnum("hr_emergency_response_status", [
  "safe",
  "need_help",
  "no_response",
]);

export const hrAccessProvisioningActionEnum = pgEnum("hr_access_provisioning_action", [
  "grant",
  "revoke",
  "review",
]);

export const hrAccessProvisioningStatusEnum = pgEnum("hr_access_provisioning_status", [
  "pending",
  "completed",
  "verified",
  "failed",
]);

export const hrAccessProvisioningTriggerEnum = pgEnum("hr_access_provisioning_trigger", [
  "joiner",
  "mover",
  "leaver",
  "manual",
]);

export const hrSimulationTypeEnum = pgEnum("hr_simulation_type", [
  "policy",
  "leave",
  "attendance",
  "approval",
  "payroll",
]);

export const hrAccommodationRequests = pgTable("hr_accommodation_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  type: hrAccommodationTypeEnum("type").notNull(),
  description: text("description").notNull(),
  confidentialMedicalNote: text("confidential_medical_note"),
  status: hrAccommodationStatusEnum("status").notNull().default("requested"),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewDate: date("review_date"),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
}, (t) => [
  unique("uniq_hr_accommodation_requests_org_id").on(t.orgId, t.id),
  index("idx_hr_acc_req_org").on(t.orgId),
  index("idx_hr_acc_req_user").on(t.userId),
]);

export const hrAccommodationTasks = pgTable("hr_accommodation_tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  requestId: uuid("request_id").notNull(),
  title: text("title").notNull(),
  assigneeUserId: text("assignee_user_id"),
  assigneeMembershipId: integer("assignee_membership_id"),
  status: hrAccommodationTaskStatusEnum("status").notNull().default("pending"),
  dueDate: date("due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.requestId], foreignColumns: [hrAccommodationRequests.orgId, hrAccommodationRequests.id], name: "fk_hr_accommodation_tasks_org_request" }).onDelete("cascade"),
  unique("uniq_hr_accommodation_tasks_org_id").on(t.orgId, t.id),
  index("idx_hr_acc_task_org").on(t.orgId),
  index("idx_hr_acc_task_request").on(t.requestId),
]);

export const hrEmergencyEvents = pgTable("hr_emergency_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: hrEmergencyEventTypeEnum("type").notNull(),
  locationId: text("location_id"),
  status: hrEmergencyEventStatusEnum("status").notNull().default("active"),
  message: text("message").notNull(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  resolvedAt: timestamp("resolved_at"),
}, (t) => [
  unique("uniq_hr_emergency_events_org_id").on(t.orgId, t.id),
  index("idx_hr_emerg_ev_org").on(t.orgId),
  index("idx_hr_emerg_ev_status").on(t.orgId, t.status),
]);

export const hrEmergencyResponses = pgTable("hr_emergency_responses", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  eventId: uuid("event_id").notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  status: hrEmergencyResponseStatusEnum("status").notNull().default("no_response"),
  respondedAt: timestamp("responded_at"),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.eventId], foreignColumns: [hrEmergencyEvents.orgId, hrEmergencyEvents.id], name: "fk_hr_emergency_responses_org_event" }).onDelete("cascade"),
  unique("uniq_hr_emergency_responses_org_id").on(t.orgId, t.id),
  index("idx_hr_emerg_resp_event").on(t.eventId),
  index("idx_hr_emerg_resp_user").on(t.orgId, t.userId),
]);

export const hrAccessProvisioning = pgTable("hr_access_provisioning", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull(),
  userMembershipId: integer("user_membership_id"),
  systemName: text("system_name").notNull(),
  action: hrAccessProvisioningActionEnum("action").notNull(),
  status: hrAccessProvisioningStatusEnum("status").notNull().default("pending"),
  triggeredBy: hrAccessProvisioningTriggerEnum("triggered_by").notNull(),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  verifiedBy: text("verified_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  unique("uniq_hr_access_provisioning_org_id").on(t.orgId, t.id),
  index("idx_hr_acc_prov_org").on(t.orgId),
  index("idx_hr_acc_prov_user").on(t.orgId, t.userId),
  index("idx_hr_acc_prov_status").on(t.orgId, t.status),
]);

export const hrAccessProvisioningTemplates = pgTable("hr_access_provisioning_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  triggeredBy: hrAccessProvisioningTriggerEnum("triggered_by").notNull(),
  systemsConfig: jsonb("systems_config").notNull().$type<{ systemName: string; action: "grant" | "revoke" | "review" }[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (t) => [
  unique("uniq_hr_access_provisioning_templates_org_id").on(t.orgId, t.id),
  index("idx_hr_acc_prov_tmpl_org").on(t.orgId),
]);

export const hrSimulations = pgTable("hr_simulations", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  type: hrSimulationTypeEnum("type").notNull(),
  input: jsonb("input").notNull().$type<Record<string, unknown>>(),
  result: jsonb("result").notNull().$type<Record<string, unknown>>(),
  createdBy: text("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("uniq_hr_simulations_org_id").on(t.orgId, t.id),
  index("idx_hr_sim_org").on(t.orgId),
  index("idx_hr_sim_type").on(t.orgId, t.type),
]);

export const hrEventStream = pgTable("hr_event_stream", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => [
  unique("uniq_hr_event_stream_org_id").on(t.orgId, t.id),
  index("idx_hr_evstream_org").on(t.orgId),
  index("idx_hr_evstream_type").on(t.orgId, t.eventType),
  index("idx_hr_evstream_entity").on(t.orgId, t.entityType, t.entityId),
  index("idx_hr_evstream_occurred").on(t.orgId, t.occurredAt),
]);

export const hrAccommodationRequestsRelations = relations(hrAccommodationRequests, ({ many }) => ({
  tasks: many(hrAccommodationTasks),
}));

export const hrAccommodationTasksRelations = relations(hrAccommodationTasks, ({ one }) => ({
  request: one(hrAccommodationRequests, {
    fields: [hrAccommodationTasks.requestId],
    references: [hrAccommodationRequests.id],
  }),
}));

export const hrEmergencyEventsRelations = relations(hrEmergencyEvents, ({ many }) => ({
  responses: many(hrEmergencyResponses),
}));

export const hrEmergencyResponsesRelations = relations(hrEmergencyResponses, ({ one }) => ({
  event: one(hrEmergencyEvents, {
    fields: [hrEmergencyResponses.eventId],
    references: [hrEmergencyEvents.id],
  }),
}));
