import { date, foreignKey, index, integer, jsonb, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { hrEmployments, hrPeople } from "./core-people";
import { hrTemplates } from "./template-engine";

export const hrProbationReviews = pgTable("hr_probation_reviews", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  employmentId: integer("employment_id").notNull(),
  personId: integer("person_id").notNull(),
  probationEndDate: date("probation_end_date").notNull(),
  status: text("status", { enum: ["in_probation", "review_due", "extended", "confirmed", "terminated"] }).notNull().default("in_probation"),
  extensionCount: integer("extension_count").notNull().default(0),
  extendedUntil: date("extended_until"),
  reviewTemplateId: integer("review_template_id"),
  reviewNotes: jsonb("review_notes").$type<Record<string, unknown>>(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.employmentId], foreignColumns: [hrEmployments.orgId, hrEmployments.id], name: "fk_hr_probation_reviews_org_employment" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.personId], foreignColumns: [hrPeople.orgId, hrPeople.id], name: "fk_hr_probation_reviews_org_person" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.reviewTemplateId], foreignColumns: [hrTemplates.orgId, hrTemplates.id], name: "fk_hr_probation_reviews_org_review_template" }).onDelete("set null"),
  unique("uniq_hr_probation_reviews_org_id").on(table.orgId, table.id),
  index("idx_hr_probation_reviews_employment").on(table.employmentId),
  index("idx_hr_probation_reviews_status").on(table.orgId, table.status),
]);

export const hrProbationReviewsRelations = relations(hrProbationReviews, ({ one }) => ({
  org: one(organizations, { fields: [hrProbationReviews.orgId], references: [organizations.id] }),
  employment: one(hrEmployments, { fields: [hrProbationReviews.employmentId], references: [hrEmployments.id] }),
  person: one(hrPeople, { fields: [hrProbationReviews.personId], references: [hrPeople.id] }),
  reviewTemplate: one(hrTemplates, { fields: [hrProbationReviews.reviewTemplateId], references: [hrTemplates.id] }),
}));
