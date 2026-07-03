import { pgTable, text, serial, timestamp, decimal, integer, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";
import { jobPostings } from "./hiring";

export const jobBoardPostings = pgTable("job_board_postings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  jobPostingId: integer("job_posting_id").references(() => jobPostings.id, { onDelete: "cascade" }).notNull(),
  platform: text("platform").notNull(),
  externalPostUrl: text("external_post_url"),
  status: text("status").default("DRAFT").notNull(),
  postedBy: text("posted_by").references(() => users.id),
  postedAt: timestamp("posted_at"),
  expiryDate: timestamp("expiry_date"),
  spend: decimal("spend", { precision: 12, scale: 2 }),
  applicantCount: integer("applicant_count").default(0).notNull(),
  qualifiedCount: integer("qualified_count").default(0).notNull(),
  hiredCount: integer("hired_count").default(0).notNull(),
  notes: text("notes"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_job_board_postings_job").on(table.jobPostingId),
  index("idx_job_board_postings_org").on(table.orgId),
]);

export const jobBoardPostingsRelations = relations(jobBoardPostings, ({ one }) => ({
  jobPosting: one(jobPostings, { fields: [jobBoardPostings.jobPostingId], references: [jobPostings.id] }),
}));
