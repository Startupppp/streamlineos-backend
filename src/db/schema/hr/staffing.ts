import { decimal, foreignKey, index, integer, pgTable, serial, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "../common/auth";
import { candidates } from "./hiring-candidates";
import { jobPostings } from "./hiring-core";

export type ExternalReferrerStatus = "ACTIVE" | "BLOCKED";

export const externalReferrers = pgTable("external_referrers", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  referralToken: text("referral_token").notNull(),
  status: text("status").$type<ExternalReferrerStatus>().notNull().default("ACTIVE"),
  emailVerifiedAt: timestamp("email_verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("uniq_external_referrers_org_id").on(table.orgId, table.id),
  uniqueIndex("idx_external_referrers_org_email").on(table.orgId, table.email),
  uniqueIndex("idx_external_referrers_token").on(table.referralToken),
]);

export type ExternalReferralStatus =
  | "SUBMITTED"
  | "REVIEWING"
  | "HIRED"
  | "REJECTED"
  | "INELIGIBLE"
  | "REWARD_PENDING"
  | "REWARD_PAID";

export const externalReferrals = pgTable("external_referrals", {
  id: serial("id").primaryKey(),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  referrerId: integer("referrer_id").notNull(),
  candidateId: integer("candidate_id").notNull(),
  jobPostingId: integer("job_posting_id"),
  status: text("status").$type<ExternalReferralStatus>().notNull().default("SUBMITTED"),
  rewardAmount: decimal("reward_amount", { precision: 12, scale: 2 }),
  rewardPaidAt: timestamp("reward_paid_at"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ columns: [table.orgId, table.candidateId], foreignColumns: [candidates.orgId, candidates.id], name: "fk_external_referrals_org_candidate" }).onDelete("cascade"),
  foreignKey({ columns: [table.orgId, table.jobPostingId], foreignColumns: [jobPostings.orgId, jobPostings.id], name: "fk_external_referrals_job_posting_id_org" }),
  foreignKey({ columns: [table.orgId, table.referrerId], foreignColumns: [externalReferrers.orgId, externalReferrers.id], name: "fk_external_referrals_org_referrer" }).onDelete("cascade"),
  unique("uniq_external_referrals_org_id").on(table.orgId, table.id),
  uniqueIndex("idx_external_referrals_referrer_candidate").on(table.referrerId, table.candidateId),
  index("idx_external_referrals_org").on(table.orgId),
  index("idx_external_referrals_candidate").on(table.candidateId),
]);

export const externalReferrersRelations = relations(externalReferrers, ({ one, many }) => ({
  organization: one(organizations, { fields: [externalReferrers.orgId], references: [organizations.id] }),
  referrals: many(externalReferrals),
}));

export const externalReferralsRelations = relations(externalReferrals, ({ one }) => ({
  organization: one(organizations, { fields: [externalReferrals.orgId], references: [organizations.id] }),
  referrer: one(externalReferrers, { fields: [externalReferrals.referrerId], references: [externalReferrers.id] }),
  candidate: one(candidates, { fields: [externalReferrals.candidateId], references: [candidates.id] }),
  jobPosting: one(jobPostings, { fields: [externalReferrals.jobPostingId], references: [jobPostings.id] }),
}));
