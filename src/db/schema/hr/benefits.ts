import {
  pgTable,
  pgEnum,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "../auth";

export const hrBenefitCategoryEnum = pgEnum("hr_benefit_category", [
  "health",
  "life",
  "accident",
  "retirement",
  "wellness",
  "perk",
  "other",
]);

export const hrBenefitStatusEnum = pgEnum("hr_benefit_status", [
  "draft",
  "active",
  "archived",
]);

export const hrEnrollmentStatusEnum = pgEnum("hr_enrollment_status", [
  "pending",
  "active",
  "waived",
  "terminated",
]);

export const hrEnrollmentWindowStatusEnum = pgEnum("hr_enrollment_window_status", [
  "upcoming",
  "open",
  "closed",
]);

export const hrDependentRelationshipEnum = pgEnum("hr_dependent_relationship", [
  "spouse",
  "child",
  "parent",
  "other",
]);

export const hrClaimStatusEnum = pgEnum("hr_claim_status", [
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "paid",
]);

export const hrClaimPayoutRouteEnum = pgEnum("hr_claim_payout_route", [
  "payroll_payable",
  "finance_payable",
  "already_paid",
]);

export const hrLoanRepaymentStatusEnum = pgEnum("hr_loan_repayment_status", [
  "pending",
  "deducted",
  "paid",
  "skipped",
]);

export const hrBenefitPlans = pgTable(
  "hr_benefit_plans",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    category: hrBenefitCategoryEnum("category").notNull(),
    provider: text("provider"),
    description: text("description"),
    coverage: jsonb("coverage").$type<Record<string, unknown>>(),
    premiumCents: integer("premium_cents"),
    employerContributionPct: integer("employer_contribution_pct").default(0).notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    status: hrBenefitStatusEnum("status").default("draft").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_hr_benefit_plans_org_name").on(table.orgId, table.name),
    index("idx_hr_benefit_plans_org_status").on(table.orgId, table.status),
    index("idx_hr_benefit_plans_org_category").on(table.orgId, table.category),
  ],
);

export const hrBenefitEnrollmentWindows = pgTable(
  "hr_benefit_enrollment_windows",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    planId: integer("plan_id").references(() => hrBenefitPlans.id, { onDelete: "cascade" }),
    opensAt: timestamp("opens_at").notNull(),
    closesAt: timestamp("closes_at").notNull(),
    status: hrEnrollmentWindowStatusEnum("status").default("upcoming").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_hr_enroll_windows_org_status").on(table.orgId, table.status),
    index("idx_hr_enroll_windows_org_plan").on(table.orgId, table.planId),
  ],
);

export const hrBenefitEnrollments = pgTable(
  "hr_benefit_enrollments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    planId: integer("plan_id")
      .references(() => hrBenefitPlans.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    status: hrEnrollmentStatusEnum("status").default("pending").notNull(),
    enrolledAt: timestamp("enrolled_at").defaultNow().notNull(),
    effectiveFrom: date("effective_from"),
    dependentsCovered: integer("dependents_covered").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_hr_benefit_enrollments_org_plan_user").on(table.orgId, table.planId, table.userId),
    index("idx_hr_benefit_enrollments_org_user").on(table.orgId, table.userId),
    index("idx_hr_benefit_enrollments_org_plan").on(table.orgId, table.planId),
  ],
);

export const hrDependents = pgTable(
  "hr_dependents",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    relationship: hrDependentRelationshipEnum("relationship").notNull(),
    dateOfBirth: date("date_of_birth"),
    isCovered: boolean("is_covered").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    index("idx_hr_dependents_org_user").on(table.orgId, table.userId),
  ],
);

export const hrInsuranceClaims = pgTable(
  "hr_insurance_claims",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    planId: integer("plan_id")
      .references(() => hrBenefitPlans.id, { onDelete: "restrict" })
      .notNull(),
    claimNumber: text("claim_number").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: hrClaimStatusEnum("status").default("submitted").notNull(),
    documents: jsonb("documents").$type<{ url: string; name: string }[]>(),
    submittedAt: timestamp("submitted_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
    decidedBy: text("decided_by").references(() => users.id, { onDelete: "set null" }),
    rejectionReason: text("rejection_reason"),
    payoutRoute: hrClaimPayoutRouteEnum("payout_route"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_hr_insurance_claims_org_number").on(table.orgId, table.claimNumber),
    index("idx_hr_insurance_claims_org_user").on(table.orgId, table.userId),
    index("idx_hr_insurance_claims_org_status").on(table.orgId, table.status),
    index("idx_hr_insurance_claims_org_plan").on(table.orgId, table.planId),
  ],
);

export const hrLoanRepayments = pgTable(
  "hr_loan_repayments",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    loanId: integer("loan_id").notNull(),
    installmentNo: integer("installment_no").notNull(),
    dueDate: date("due_date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: hrLoanRepaymentStatusEnum("status").default("pending").notNull(),
    payrollPeriodKey: text("payroll_period_key"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_hr_loan_repayments_loan_installment").on(table.loanId, table.installmentNo),
    index("idx_hr_loan_repayments_org_status").on(table.orgId, table.status),
    index("idx_hr_loan_repayments_org_due_date").on(table.orgId, table.dueDate),
  ],
);

export const hrTravelVisitLogs = pgTable(
  "hr_travel_visit_logs",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    travelRequestId: integer("travel_request_id").notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    visitedAt: timestamp("visited_at").notNull(),
    location: text("location").notNull(),
    lat: text("lat"),
    lng: text("lng"),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_hr_travel_visit_logs_org_travel").on(table.orgId, table.travelRequestId),
    index("idx_hr_travel_visit_logs_org_user").on(table.orgId, table.userId),
  ],
);

export const hrBenefitPlansRelations = relations(hrBenefitPlans, ({ many }) => ({
  enrollments: many(hrBenefitEnrollments),
  claims: many(hrInsuranceClaims),
  windows: many(hrBenefitEnrollmentWindows),
}));

export const hrBenefitEnrollmentsRelations = relations(hrBenefitEnrollments, ({ one }) => ({
  plan: one(hrBenefitPlans, { fields: [hrBenefitEnrollments.planId], references: [hrBenefitPlans.id] }),
  user: one(users, { fields: [hrBenefitEnrollments.userId], references: [users.id] }),
}));

export const hrInsuranceClaimsRelations = relations(hrInsuranceClaims, ({ one }) => ({
  plan: one(hrBenefitPlans, { fields: [hrInsuranceClaims.planId], references: [hrBenefitPlans.id] }),
  user: one(users, { fields: [hrInsuranceClaims.userId], references: [users.id] }),
  decider: one(users, {
    fields: [hrInsuranceClaims.decidedBy],
    references: [users.id],
    relationName: "claimDecider",
  }),
}));

export const hrDependentsRelations = relations(hrDependents, ({ one }) => ({
  user: one(users, { fields: [hrDependents.userId], references: [users.id] }),
}));

export const hrBenefitEnrollmentWindowsRelations = relations(hrBenefitEnrollmentWindows, ({ one }) => ({
  plan: one(hrBenefitPlans, { fields: [hrBenefitEnrollmentWindows.planId], references: [hrBenefitPlans.id] }),
}));
