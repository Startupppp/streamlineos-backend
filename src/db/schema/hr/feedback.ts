import { boolean, foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

export const feedbackCycles = pgTable("feedback_cycles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: text("type").default("360").notNull(),
  status: text("status").default("DRAFT").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  isAnonymous: boolean("is_anonymous").default(true).notNull(),
  questions: jsonb("questions").$type<{ id: string; text: string; type: "rating" | "text" }[]>().default([]).notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_feedback_cycles_org_id").on(table.orgId, table.id),
  index("idx_feedback_cycles_org_status").on(table.orgId, table.status),
]);

export const feedbackCycleRequests = pgTable("feedback_cycle_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id"),
  cycleId: integer("cycle_id").notNull(),
  subjectId: text("subject_id").notNull(),
  subjectMembershipId: integer("subject_membership_id"),
  reviewerId: text("reviewer_id").notNull(),
  reviewerMembershipId: integer("reviewer_membership_id"),
  relationship: text("relationship").notNull(),
  status: text("status").default("PENDING").notNull(),
  submittedAt: timestamp("submitted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.cycleId], foreignColumns: [feedbackCycles.orgId, feedbackCycles.id], name: "fk_feedback_cycle_requests_cycle_id_org" }).onDelete("cascade"),
  uniqueIndex("uniq_fb_cycle_req_cycle_sub_rev").on(table.cycleId, table.subjectId, table.reviewerId),
  index("idx_fb_cycle_requests_reviewer").on(table.reviewerId, table.status),
  index("idx_fb_cycle_requests_org_cycle_reviewer").on(table.orgId, table.cycleId, table.reviewerId),
]);

export const feedbackCycleResponses = pgTable("feedback_cycle_responses", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  responses: jsonb("responses").$type<{ questionId: string; rating?: number; text?: string }[]>().default([]).notNull(),
  overallRating: integer("overall_rating"),
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.requestId], foreignColumns: [feedbackCycleRequests.orgId, feedbackCycleRequests.id], name: "fk_feedback_cycle_responses_request_id_org" }).onDelete("cascade"),
  index("idx_fb_cycle_responses_request").on(table.requestId),
  index("idx_feedback_cycle_responses_org_request").on(table.orgId, table.requestId),
]);
