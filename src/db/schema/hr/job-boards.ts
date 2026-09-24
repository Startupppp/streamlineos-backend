import { decimal, foreignKey, index, integer, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { jobPostings } from "./hiring-core";

export const jobBoardPostings = pgTable("job_board_postings", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  jobPostingId: integer("job_posting_id").notNull(),
  platform: text("platform").notNull(),
  externalPostUrl: text("external_post_url"),
  /**
   * The handle the board returned. `external_post_url` is for a human to click;
   * this is what a status poll or an unpublish is addressed to, and it is only
   * ever written from an id a vendor actually sent back.
   */
  externalPostingId: text("external_posting_id"),
  status: text("status").default("DRAFT").notNull(),
  /** Why the row is in this status — a blocked code, or the vendor's refusal. */
  statusDetail: text("status_detail"),
  lastAttemptAt: timestamp("last_attempt_at"),
  lastSyncedAt: timestamp("last_synced_at"),
  postedBy: text("posted_by"),
  postedAt: timestamp("posted_at"),
  expiryDate: timestamp("expiry_date"),
  spend: decimal("spend", { precision: 12, scale: 2 }),
  applicantCount: integer("applicant_count").default(0).notNull(),
  qualifiedCount: integer("qualified_count").default(0).notNull(),
  hiredCount: integer("hired_count").default(0).notNull(),
  notes: text("notes"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_job_board_postings_org_job_posting" }).onDelete("cascade"),
  unique("uniq_job_board_postings_org_id").on(table.orgId, table.id),
  index("idx_job_board_postings_job").on(table.jobPostingId),
  /**
   * One publication per (org, job, board). Publishing the same job to the same
   * board twice updates the attempt; it must not stack duplicate rows that then
   * disagree about whether the ad is live.
   */
  uniqueIndex("uq_job_board_postings_org_job_platform").on(table.orgId, table.jobPostingId, table.platform),
  index("idx_job_board_postings_org_status").on(table.orgId, table.status),
]);

export const jobBoardPostingsRelations = relations(jobBoardPostings, ({ one }) => ({
  jobPosting: one(jobPostings, { fields: [jobBoardPostings.jobPostingId], references: [jobPostings.id] }),
}));
