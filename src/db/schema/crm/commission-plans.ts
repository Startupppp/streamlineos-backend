import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations, users } from "../common/auth";

/**
 * What a payout is computed FROM: the rule-set vocabulary, the plan, its dated
 * versions, and who is on it. Re-exported through `crm/commission.ts`, whose
 * docblock states the design these tables carry.
 */

/** Rounded rates are basis points throughout: 1 bp = 0.01%, so 10000 bp = 1x. */
export const BPS_SCALE = 10_000;

/**
 * One band of a marginal rate table.
 *
 * `from` is a position along the earner's cumulative basis for the period, and
 * what it is measured in depends on whether the version carries a quota:
 * attainment basis points against quota when it does, minor units of cumulative
 * basis when it does not. Storing one number rather than two shapes keeps the
 * evaluator from having to guess which the tenant meant.
 */
export interface CommissionTier {
  from: number;
  rateBps: number;
}

/**
 * A multiplier that applies to the slices of basis at or above a position.
 *
 * Deliberately positional rather than applied to the whole earning: a
 * whole-earning multiplier makes the single deal that crosses the threshold pay
 * more than the same revenue split across two, which is an arbitrage a
 * commission plan should not contain.
 */
export interface CommissionAccelerator {
  aboveBps: number;
  multiplierBps: number;
}

export const COMMISSION_PERIODS = ["MONTH", "QUARTER", "YEAR"] as const;
export type CommissionPeriod = (typeof COMMISSION_PERIODS)[number];

export const COMMISSION_BASES = ["deal_value"] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];

/** The whole of a plan version's behaviour, as data. */
export interface CommissionRuleSet {
  /** Which number on the source record the bands are applied to. */
  basis: CommissionBasis;
  /** The window attainment is accumulated over before it resets. */
  period: CommissionPeriod;
  /** Quota for one period in minor units; null means bands read absolute basis. */
  quotaMinor: number | null;
  /** Ascending, non-overlapping, first band starting at 0. */
  tiers: CommissionTier[];
  /** Ascending by threshold; may be empty. */
  accelerators: CommissionAccelerator[];
  /** Ceiling on a single earning in minor units; null means uncapped. */
  capMinor: number | null;
}

export const COMMISSION_EARNING_STATUSES = [
  "CALCULATED",
  "APPROVED",
  "PAID",
  "VOID",
] as const;
export type CommissionEarningStatus =
  (typeof COMMISSION_EARNING_STATUSES)[number];

/**
 * The plan's identity, and nothing that can change what it pays.
 *
 * Every number a payout depends on lives on the version, so this row is safe to
 * rename or re-describe at any time — an audit of a historical payout reads the
 * version, and a plan whose name changed still reproduces the same money.
 */
export const crmCommissionPlans = pgTable(
  "crm_commission_plans",
  {
    planId: text("plan_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * ISO 4217, copied onto every earning the plan produces.
     *
     * On the earning rather than read through a join, because the tenant's
     * currency can be changed and a payout must keep reporting the units it was
     * actually computed in.
     */
    currency: text("currency").default("INR").notNull(),
    /** Set to stop new versions and new assignments; never deletes history. */
    retiredOn: date("retired_on"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uniq_crm_commission_plans_org_name").on(t.orgId, t.name),
    index("idx_crm_commission_plans_org").on(t.orgId, t.retiredOn),
  ],
);

/**
 * A dated, immutable-once-earned-against rule set.
 *
 * There is no `effective_to` column, and that is the load-bearing decision. The
 * version in force on a date is the one with the greatest `effective_from` less
 * than or equal to it, which makes gaps and overlaps unrepresentable rather than
 * merely discouraged — there is no second date to contradict the first, and no
 * interval constraint anybody can forget to write. The cost is that a plan
 * cannot be paused mid-life; ending it is `plans.retiredOn`, which is a plan
 * fact rather than a version fact.
 */
export const crmCommissionPlanVersions = pgTable(
  "crm_commission_plan_versions",
  {
    planVersionId: text("plan_version_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    planId: text("plan_id")
      .references(() => crmCommissionPlans.planId, { onDelete: "cascade" })
      .notNull(),
    /** 1-based, dense, and ordered the same way as `effectiveFrom`. */
    versionNumber: integer("version_number").notNull(),
    /** The first day this rule set governs. Selects the version for an earning. */
    effectiveFrom: date("effective_from").notNull(),
    rules: jsonb("rules").$type<CommissionRuleSet>().notNull(),
    /**
     * When the first earning cited this version.
     *
     * Null means the version is still editable. Non-null means money has been
     * computed from it, and the whole point of the ticket is that such a version
     * can never be restated: `trg_crm_commission_plan_versions_seal` raises on
     * any UPDATE to `rules`, `effective_from` or `version_number` after this is
     * set, and on DELETE. The service refuses first for a readable 409; the
     * trigger is what makes the refusal true for writers that are not the
     * service.
     */
    sealedAt: timestamp("sealed_at"),
    note: text("note"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uniq_crm_commission_plan_versions_number").on(
      t.orgId,
      t.planId,
      t.versionNumber,
    ),
    /**
     * Two versions starting on the same day would make "the greatest
     * `effective_from` at or before D" ambiguous, and the payout would then
     * depend on which row the planner returned first.
     */
    uniqueIndex("uniq_crm_commission_plan_versions_effective").on(
      t.orgId,
      t.planId,
      t.effectiveFrom,
    ),
    /** The resolution read: one plan, newest version at or before a date. */
    index("idx_crm_commission_plan_versions_lookup").on(
      t.orgId,
      t.planId,
      t.effectiveFrom,
    ),
  ],
);

/**
 * Who is on which plan, dated the same way earnings are.
 *
 * At most one plan per person at a time — a second concurrent assignment would
 * mean one deal earns twice and neither payout is wrong on its own terms. The
 * open-ended row is held unique by a partial index; a closed row's `effectiveTo`
 * is inclusive.
 */
export const crmCommissionAssignments = pgTable(
  "crm_commission_assignments",
  {
    assignmentId: text("assignment_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    planId: text("plan_id")
      .references(() => crmCommissionPlans.planId, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** Inclusive last day; null while the person is still on the plan. */
    effectiveTo: date("effective_to"),
    /**
     * Overrides `rules.quotaMinor` for this person, in minor units.
     *
     * On the assignment rather than the version because a quota is a property of
     * the individual's target, not of the scheme — two reps on identical rules
     * routinely carry different numbers, and forking the version per rep would
     * make the plan unreadable.
     */
    quotaOverrideMinor: bigint("quota_override_minor", { mode: "number" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uniq_crm_commission_assignments_start").on(
      t.orgId,
      t.userId,
      t.effectiveFrom,
    ),
    uniqueIndex("uniq_crm_commission_assignments_open")
      .on(t.orgId, t.userId)
      .where(sql`effective_to IS NULL`),
    index("idx_crm_commission_assignments_lookup").on(
      t.orgId,
      t.userId,
      t.effectiveFrom,
    ),
    index("idx_crm_commission_assignments_plan").on(t.orgId, t.planId),
  ],
);
