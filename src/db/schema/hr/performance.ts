import { pgTable, pgEnum, text, serial, timestamp, boolean, jsonb, decimal, date, integer, index, uniqueIndex, unique, foreignKey, numeric } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  reviewStatusEnum, reviewCycleStatusEnum, meetingStatusEnum,
  pipStatusEnum, surveyStatusEnum, feedbackTypeEnum,
} from "../common/enums";
import { organizations, users } from "../common/auth";
import { hrTemplates } from "./template-engine";

export const successionReadinessEnum = pgEnum("succession_readiness", ["ready_now", "1_2_years", "3_plus"]);

export const reviewCycles = pgTable("review_cycles", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  type: text("type").default("QUARTERLY").notNull(),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  deadline: date("deadline"),
  status: reviewCycleStatusEnum("status").default("DRAFT").notNull(),
  description: text("description"),
  templateId: integer("template_id").references(() => hrTemplates.id, { onDelete: "set null" }),
  templateVersion: integer("template_version"),
  ratingScale: jsonb("rating_scale").$type<{ points: number; labels: Record<string, string> }>(),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_review_cycles_org_id").on(table.orgId, table.id),
  index("idx_review_cycles_org").on(table.orgId),
]);

export const performanceReviews = pgTable("performance_reviews", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  reviewerId: text("reviewer_id").references(() => users.id),
  cycleId: integer("cycle_id").references(() => reviewCycles.id),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  status: reviewStatusEnum("status").default("DRAFT").notNull(),
  ratings: jsonb("ratings").$type<{ category: string; score: number; comment?: string }[]>(),
  strengths: text("strengths"),
  improvements: text("improvements"),
  goals: jsonb("goals").$type<{ goal: string; achieved: boolean }[]>(),
  overallRating: decimal("overall_rating", { precision: 4, scale: 2 }),
  comments: text("comments"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_performance_reviews_org_id").on(table.orgId, table.id),
  index("idx_perf_reviews_org_cycle").on(table.orgId, table.cycleId),
  index("idx_perf_reviews_user").on(table.userId),
]);

export const oneOnOneMeetings = pgTable("one_on_one_meetings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  managerId: text("manager_id").references(() => users.id).notNull(),
  employeeId: text("employee_id").references(() => users.id).notNull(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  duration: integer("duration").default(30).notNull(),
  status: meetingStatusEnum("status").default("SCHEDULED").notNull(),
  notes: text("notes"),
  actionItems: jsonb("action_items").$type<{ text: string; done: boolean }[]>(),
  agenda: text("agenda"),
  meetingLink: text("meeting_link"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_one_on_one_meetings_org_id").on(table.orgId, table.id),
  index("idx_one_on_ones_org").on(table.orgId),
  index("idx_one_on_ones_manager").on(table.managerId),
  index("idx_one_on_ones_scheduled").on(table.scheduledAt),
]);

export const oneOnOneActionItems = pgTable("one_on_one_action_items", {
  id: serial("id").primaryKey(),
  meetingId: integer("meeting_id").references(() => oneOnOneMeetings.id, { onDelete: "cascade" }).notNull(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  text: text("text").notNull(),
  done: boolean("done").default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_one_on_one_action_items_org_id").on(table.orgId, table.id),
  index("idx_one_on_one_action_items_meeting").on(table.meetingId),
  index("idx_one_on_one_action_items_org").on(table.orgId),
]);

export const oneOnOneActionItemsRelations = relations(oneOnOneActionItems, ({ one }) => ({
  meeting: one(oneOnOneMeetings, { fields: [oneOnOneActionItems.meetingId], references: [oneOnOneMeetings.id] }),
}));

export const goals = pgTable("goals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  type: text("type").default("OKR").notNull(),
  targetValue: decimal("target_value", { precision: 15, scale: 2 }),
  currentValue: decimal("current_value", { precision: 15, scale: 2 }).default("0").notNull(),
  unit: text("unit"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  status: text("status").default("IN_PROGRESS").notNull(),
  progress: integer("progress").default(0).notNull(),
  parentGoalId: integer("parent_goal_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_goals_org_id").on(table.orgId, table.id),
  foreignKey({ columns: [table.parentGoalId], foreignColumns: [table.id] }).onDelete("set null"),
  index("idx_goals_user_status").on(table.userId, table.status),
  index("idx_goals_org_status").on(table.orgId, table.status),
]);

export const keyResults = pgTable("key_results", {
  id: serial("id").primaryKey(),
  goalId: integer("goal_id").references(() => goals.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  targetValue: decimal("target_value", { precision: 15, scale: 2 }),
  currentValue: decimal("current_value", { precision: 15, scale: 2 }).default("0").notNull(),
  unit: text("unit"),
  progress: integer("progress").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_key_results_goal").on(table.goalId),
]);

export const performanceImprovementPlans = pgTable("performance_improvement_plans", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  managerId: text("manager_id").references(() => users.id).notNull(),
  hrRepId: text("hr_rep_id").references(() => users.id),
  reason: text("reason").notNull(),
  objectives: jsonb("objectives").$type<{ objective: string; metric: string; deadline: string }[]>(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  status: pipStatusEnum("status").default("ACTIVE").notNull(),
  outcome: text("outcome"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_performance_improvement_plans_org_id").on(table.orgId, table.id),
  index("idx_pip_user").on(table.userId),
]);

export const pulseSurveys = pgTable("pulse_surveys", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  questions: jsonb("questions").$type<{ id: string; text: string; type: "rating" | "text" | "choice"; options?: string[] }[]>(),
  status: surveyStatusEnum("status").default("DRAFT").notNull(),
  isAnonymous: boolean("is_anonymous").default(true).notNull(),
  createdBy: text("created_by").references(() => users.id),
  closesAt: timestamp("closes_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_pulse_surveys_org_id").on(table.orgId, table.id),
  index("idx_surveys_org").on(table.orgId),
]);

export const surveyResponses = pgTable("survey_responses", {
  id: serial("id").primaryKey(),
  surveyId: integer("survey_id").references(() => pulseSurveys.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id),
  answers: jsonb("answers").$type<{ questionId: string; value: string | number }[]>(),
  submittedAt: timestamp("submitted_at").defaultNow().notNull(),
}, (table) => [
  index("idx_survey_responses_survey").on(table.surveyId),
]);

export const feedbackRequests = pgTable("feedback_requests", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  subjectUserId: text("subject_user_id").references(() => users.id).notNull(),
  reviewerUserId: text("reviewer_user_id").references(() => users.id).notNull(),
  type: feedbackTypeEnum("type").notNull(),
  cycleId: integer("cycle_id").references(() => reviewCycles.id),
  ratings: jsonb("ratings").$type<{ category: string; score: number; comment?: string }[]>(),
  strengths: text("strengths"),
  improvements: text("improvements"),
  overallRating: integer("overall_rating"),
  isCompleted: boolean("is_completed").default(false).notNull(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_feedback_requests_org_id").on(table.orgId, table.id),
  index("idx_feedback_subject").on(table.subjectUserId),
  index("idx_feedback_reviewer").on(table.reviewerUserId),
]);

export const enpsScores = pgTable("enps_scores", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id),
  score: integer("score").notNull(),
  comment: text("comment"),
  isAnonymous: boolean("is_anonymous").default(true).notNull(),
  period: text("period"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_enps_scores_org_id").on(table.orgId, table.id),
  index("idx_enps_org_period").on(table.orgId, table.period),
]);

export const recognitions = pgTable("recognitions", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  fromUserId: text("from_user_id").references(() => users.id).notNull(),
  toUserId: text("to_user_id").references(() => users.id).notNull(),
  message: text("message").notNull(),
  category: text("category").default("KUDOS").notNull(),
  isPublic: boolean("is_public").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_recognitions_org_id").on(table.orgId, table.id),
  index("idx_recognitions_org").on(table.orgId),
  index("idx_recognitions_to_user").on(table.toUserId),
]);

export const employeeSkills = pgTable("employee_skills", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  skillName: text("skill_name").notNull(),
  level: integer("level").default(1).notNull(),
  verifiedBy: text("verified_by").references(() => users.id),
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_employee_skills_org_id").on(table.orgId, table.id),
  index("idx_employee_skills_user").on(table.userId),
  index("idx_employee_skills_name").on(table.skillName),
]);

export const skillAssessments = pgTable("skill_assessments", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  skillName: text("skill_name").notNull(),
  questions: jsonb("questions").$type<{ id: string; question: string; options: string[]; correctIndex: number }[]>(),
  passingScore: integer("passing_score").default(70).notNull(),
  timeLimit: integer("time_limit"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_skill_assessments_org_id").on(table.orgId, table.id),
  index("idx_skill_assessments_org").on(table.orgId),
]);

export const assessmentAttempts = pgTable("assessment_attempts", {
  id: serial("id").primaryKey(),
  assessmentId: integer("assessment_id").references(() => skillAssessments.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  answers: jsonb("answers").$type<{ questionId: string; selectedIndex: number }[]>(),
  score: integer("score"),
  passed: boolean("passed").default(false).notNull(),
  completedAt: timestamp("completed_at").defaultNow().notNull(),
}, (table) => [
  index("idx_assessment_attempts_user").on(table.userId),
]);

export const reviewCyclesRelations = relations(reviewCycles, ({ one, many }) => ({
  organization: one(organizations, { fields: [reviewCycles.orgId], references: [organizations.id] }),
  creator: one(users, { fields: [reviewCycles.createdBy], references: [users.id] }),
  reviews: many(performanceReviews),
}));

export const performanceReviewsRelations = relations(performanceReviews, ({ one }) => ({
  user: one(users, { fields: [performanceReviews.userId], references: [users.id], relationName: "reviewUser" }),
  reviewer: one(users, { fields: [performanceReviews.reviewerId], references: [users.id], relationName: "reviewReviewer" }),
  cycle: one(reviewCycles, { fields: [performanceReviews.cycleId], references: [reviewCycles.id] }),
}));

export const oneOnOneMeetingsRelations = relations(oneOnOneMeetings, ({ one }) => ({
  organization: one(organizations, { fields: [oneOnOneMeetings.orgId], references: [organizations.id] }),
  manager: one(users, { fields: [oneOnOneMeetings.managerId], references: [users.id], relationName: "meetingManager" }),
  employee: one(users, { fields: [oneOnOneMeetings.employeeId], references: [users.id], relationName: "meetingEmployee" }),
}));

export const goalsRelations = relations(goals, ({ one }) => ({
  user: one(users, { fields: [goals.userId], references: [users.id] }),
  parent: one(goals, { fields: [goals.parentGoalId], references: [goals.id] }),
}));

export const keyResultsRelations = relations(keyResults, ({ one }) => ({
  goal: one(goals, { fields: [keyResults.goalId], references: [goals.id] }),
}));

export const pipRelations = relations(performanceImprovementPlans, ({ one }) => ({
  user: one(users, { fields: [performanceImprovementPlans.userId], references: [users.id] }),
  manager: one(users, { fields: [performanceImprovementPlans.managerId], references: [users.id], relationName: "pipManager" }),
  hrRep: one(users, { fields: [performanceImprovementPlans.hrRepId], references: [users.id], relationName: "pipHrRep" }),
}));

export const pulseSurveysRelations = relations(pulseSurveys, ({ one, many }) => ({
  creator: one(users, { fields: [pulseSurveys.createdBy], references: [users.id] }),
  responses: many(surveyResponses),
}));

export const surveyResponsesRelations = relations(surveyResponses, ({ one }) => ({
  survey: one(pulseSurveys, { fields: [surveyResponses.surveyId], references: [pulseSurveys.id] }),
  user: one(users, { fields: [surveyResponses.userId], references: [users.id] }),
}));

export const feedbackRequestsRelations = relations(feedbackRequests, ({ one }) => ({
  subject: one(users, { fields: [feedbackRequests.subjectUserId], references: [users.id], relationName: "feedbackSubject" }),
  reviewer: one(users, { fields: [feedbackRequests.reviewerUserId], references: [users.id], relationName: "feedbackReviewer" }),
  cycle: one(reviewCycles, { fields: [feedbackRequests.cycleId], references: [reviewCycles.id] }),
}));

export const recognitionsRelations = relations(recognitions, ({ one }) => ({
  fromUser: one(users, { fields: [recognitions.fromUserId], references: [users.id], relationName: "recognitionFrom" }),
  toUser: one(users, { fields: [recognitions.toUserId], references: [users.id], relationName: "recognitionTo" }),
}));

export const employeeSkillsRelations = relations(employeeSkills, ({ one }) => ({
  user: one(users, { fields: [employeeSkills.userId], references: [users.id] }),
  verifier: one(users, { fields: [employeeSkills.verifiedBy], references: [users.id], relationName: "skillVerifier" }),
}));

export const skillAssessmentsRelations = relations(skillAssessments, ({ one, many }) => ({
  creator: one(users, { fields: [skillAssessments.createdBy], references: [users.id] }),
  attempts: many(assessmentAttempts),
}));

export const assessmentAttemptsRelations = relations(assessmentAttempts, ({ one }) => ({
  assessment: one(skillAssessments, { fields: [assessmentAttempts.assessmentId], references: [skillAssessments.id] }),
  user: one(users, { fields: [assessmentAttempts.userId], references: [users.id] }),
}));

export const hrCalibrationEntries = pgTable("hr_calibration_entries", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  cycleId: integer("cycle_id").references(() => reviewCycles.id, { onDelete: "cascade" }).notNull(),
  employeeId: text("employee_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  preRating: numeric("pre_rating", { precision: 3, scale: 1 }),
  postRating: numeric("post_rating", { precision: 3, scale: 1 }),
  calibratedBy: text("calibrated_by").references(() => users.id, { onDelete: "set null" }),
  note: text("note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  unique("uniq_hr_calibration_entries_org_id").on(table.orgId, table.id),
  index("idx_calibration_entries_org").on(table.orgId),
  index("idx_calibration_entries_cycle").on(table.cycleId),
  uniqueIndex("uniq_calibration_cycle_employee").on(table.cycleId, table.employeeId),
]);

export const hrCalibrationEntriesRelations = relations(hrCalibrationEntries, ({ one }) => ({
  organization: one(organizations, { fields: [hrCalibrationEntries.orgId], references: [organizations.id] }),
  cycle: one(reviewCycles, { fields: [hrCalibrationEntries.cycleId], references: [reviewCycles.id] }),
  employee: one(users, { fields: [hrCalibrationEntries.employeeId], references: [users.id], relationName: "calibrationEmployee" }),
  calibratedByUser: one(users, { fields: [hrCalibrationEntries.calibratedBy], references: [users.id], relationName: "calibrationCalibrator" }),
}));
