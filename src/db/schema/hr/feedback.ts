import { pgTable, text, serial, timestamp, boolean, jsonb, integer, index, uniqueIndex, unique } from "drizzle-orm/pg-core";
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
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_feedback_cycles_org_id").on(table.orgId, table.id),
  index("idx_feedback_cycles_org_status").on(table.orgId, table.status),
]);

export const feedbackCycleRequests = pgTable("feedback_cycle_requests", {
  id: serial("id").primaryKey(),
  cycleId: integer("cycle_id").references(() => feedbackCycles.id, { onDelete: "cascade" }).notNull(),
  subjectId: text("subject_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  reviewerId: text("reviewer_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  relationship: text("relationship").notNull(),
  status: text("status").default("PENDING").notNull(),
  submittedAt: timestamp("submitted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uniq_fb_cycle_req_cycle_sub_rev").on(table.cycleId, table.subjectId, table.reviewerId),
  index("idx_fb_cycle_requests_reviewer").on(table.reviewerId, table.status),
]);

export const feedbackCycleResponses = pgTable("feedback_cycle_responses", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id").references(() => feedbackCycleRequests.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  responses: jsonb("responses").$type<{ questionId: string; rating?: number; text?: string }[]>().default([]).notNull(),
  overallRating: integer("overall_rating"),
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
}, (table) => [
  index("idx_fb_cycle_responses_request").on(table.requestId),
  index("idx_feedback_cycle_responses_org_request").on(table.orgId, table.requestId),
]);
