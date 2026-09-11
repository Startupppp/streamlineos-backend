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
 * Commission plans that a payout can be reproduced from.
 *
 * The tables `commission_rules` and `commissions` in `crm/deals.ts` already
 * store a commission scheme, and they cannot answer the only question that
 * matters when somebody disputes a payslip: *what was the rule on the day this
 * was earned?* `commission_rules` has one mutable row per rule with no dating at
 * all, so raising a rate from 5% to 7% silently restates every historical
 * payout that recomputes against it. `commissions` compounds it by storing
 * `commission_rate` and `commission_amount` as `decimal`, the column type this
 * repository moved off for money after it produced rounding drift on summed
 * forecasts (see the comment on `deals.valueMinor`).
 *
 * These tables replace neither — the legacy pair still has readers in
 * `modules/sales` — they are the dated, versioned, integer-minor-unit form the
 * payout path is meant to use. Three properties carry the whole design:
 *
 *  1. A plan VERSION is the unit of change. Editing a plan writes a new version
 *     with a new `effectiveFrom`; it never mutates a published one.
 *  2. A version is IMMUTABLE once earned against. `sealedAt` records the moment
 *     the first earning cited it, and a database trigger — not merely the
 *     service — refuses any later change to its rules or its dates.
 *  3. Rules are DATA. Rates, band boundaries, quotas and accelerators live in
 *     `rules` jsonb and are evaluated by `commission-rules.ts`. Nothing about a
 *     tenant's scheme requires a deploy.
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

/**
 * One earning, and enough of its derivation to defend it.
 *
 * `planVersionId` is stored rather than re-resolved on read: re-resolution would
 * be correct today and would silently start answering differently the moment
 * somebody backdated a version, which is precisely the class of change this
 * ticket exists to make visible. `computation` carries the slice-by-slice trace
 * the evaluator produced, so a dispute is answered by reading a row rather than
 * by rerunning a build.
 */
export const crmCommissionEarnings = pgTable(
  "crm_commission_earnings",
  {
    earningId: text("earning_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    planId: text("plan_id")
      .references(() => crmCommissionPlans.planId, { onDelete: "restrict" })
      .notNull(),
    planVersionId: text("plan_version_id")
      .references(() => crmCommissionPlanVersions.planVersionId, {
        onDelete: "restrict",
      })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    /** The date that selected the version. For a deal, its actual close date. */
    earnedOn: date("earned_on").notNull(),
    /** The attainment window the bands were walked over, from `rules.period`. */
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** `deal` today; the column exists so a second source needs no migration. */
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    /** What the bands were applied to, minor units. Never a float. */
    basisMinor: bigint("basis_minor", { mode: "number" }).notNull(),
    /** Cumulative basis already earned in this period before this row. */
    priorBasisMinor: bigint("prior_basis_minor", { mode: "number" })
      .default(0)
      .notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    /**
     * `amountMinor * 10000 / basisMinor`, rounded, for reporting only.
     *
     * Derived and stored rather than computed on read because a marginal band
     * table has no single rate; this is the blended one, and a reader who
     * recomputed it from a tier would get a different number and believe the row
     * was wrong.
     */
    effectiveRateBps: integer("effective_rate_bps").default(0).notNull(),
    attainmentBps: integer("attainment_bps"),
    computation: jsonb("computation").$type<Record<string, unknown>>(),
    status: text("status").default("CALCULATED").notNull(),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * Recalculating is a no-op, not a double payment. Without this the retry of
     * a request that timed out after its INSERT pays the rep twice, and nothing
     * in the ledger says which of the two rows is the real one.
     */
    uniqueIndex("uniq_crm_commission_earnings_source").on(
      t.orgId,
      t.sourceType,
      t.sourceId,
      t.userId,
    ),
    /** The attainment read: one earner's period to date. */
    index("idx_crm_commission_earnings_attainment").on(
      t.orgId,
      t.userId,
      t.planId,
      t.earnedOn,
    ),
    index("idx_crm_commission_earnings_status").on(
      t.orgId,
      t.status,
      t.earnedOn,
    ),
    index("idx_crm_commission_earnings_version").on(t.orgId, t.planVersionId),
  ],
);

/**
 * The decomposition, materialised: one row per band of one earning.
 *
 * Ticket P5-05. `crm_commission_earnings.computation` already carries a
 * slice-by-slice trace, and it cannot do this job for two reasons. It is a jsonb
 * blob, so "which deals produced this month's accrual, and under which rule?" is
 * a full scan and a re-parse rather than a query; and its slice amounts are
 * display roundings that **do not sum** to the earning they belong to — measured
 * against the evaluator, roughly a quarter of evaluations disagree by at least a
 * minor unit, and every capped one disagrees by far more.
 *
 * These rows are the same derivation apportioned so it adds up. The invariant is
 * literal and load-bearing: for any earning, the `amount_minor` of its parts sums
 * to the earning's `amount_minor` with no residue, so an accrued figure at any
 * granularity — a period, a rep, a plan version, a single rule — is the sum of a
 * set of these rows and never a number that has to be reconciled against one.
 * `trg_crm_commission_accrual_parts_reconcile` is a DEFERRABLE constraint trigger
 * that checks exactly that at commit, for every writer and not only the service.
 *
 * Append-only in practice. Parts are written in the same transaction as the
 * earning that produced them and are deleted only when that earning's
 * decomposition is rebuilt, whole, in one transaction — never edited in place,
 * because an edited part is a restatement wearing the same primary key.
 */
export const crmCommissionAccrualParts = pgTable(
  "crm_commission_accrual_parts",
  {
    partId: text("part_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    earningId: text("earning_id")
      .references(() => crmCommissionEarnings.earningId, { onDelete: "cascade" })
      .notNull(),

    /**
     * Denormalised from the earning: the earner, the plan, the exact version,
     * the period and the source.
     *
     * Redundant on purpose. The read this table exists for is "everything that
     * built this month's number for this person, broken down by deal and by
     * rule", and making that a four-table join would put the accrual query on
     * the slow path of the one screen the ticket wants people watching daily.
     * Drift is not a risk the way it usually is: these are copied at insert from
     * an earning whose own values never change, and a rebuild replaces the parts
     * rather than patching them.
     */
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    planId: text("plan_id")
      .references(() => crmCommissionPlans.planId, { onDelete: "restrict" })
      .notNull(),
    planVersionId: text("plan_version_id")
      .references(() => crmCommissionPlanVersions.planVersionId, {
        onDelete: "restrict",
      })
      .notNull(),
    earnedOn: date("earned_on").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** The deal. This column is what "decomposes to the deals" means. */
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),

    /** Dense from 0 within an earning, and the ledger's stable sort key. */
    partIndex: integer("part_index").notNull(),

    /**
     * Which rule paid this part.
     *
     * `tier_index` rather than the rate alone, because two bands of one plan may
     * share a rate — 10% to quota, 15% to 150%, 10% beyond is a real shape — and
     * attributing by rate would credit the third band's money to the first.
     * `rate_bps` and `multiplier_bps` are stored alongside so a part stays
     * readable without resolving the version's rule document, and so a
     * decomposition still names its rule after a later version has renumbered
     * its bands.
     */
    tierIndex: integer("tier_index").notNull(),
    /** The band's declared `from`: attainment bps with a quota, minor without. */
    tierFrom: bigint("tier_from", { mode: "number" }).notNull(),
    rateBps: integer("rate_bps").notNull(),
    /** 10000 when no accelerator applied to this band. */
    multiplierBps: integer("multiplier_bps").notNull(),

    /** Cumulative window of the earner's period basis this band consumed. */
    sliceFromMinor: bigint("slice_from_minor", { mode: "number" }).notNull(),
    sliceToMinor: bigint("slice_to_minor", { mode: "number" }).notNull(),
    /** How much basis fell in the band, minor units. */
    basisMinor: bigint("basis_minor", { mode: "number" }).notNull(),

    /**
     * This part's exact share of the earning, minor units.
     *
     * Apportioned from the earning's settled total by largest remainder, not
     * recomputed from the rate — so a cap is attributed proportionally to the
     * bands that earned it instead of vanishing, and the parts reconstruct the
     * total rather than approximating it.
     */
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    /** A part is identified by its earning and its position; a rebuild replaces. */
    uniqueIndex("uniq_crm_commission_accrual_parts_slot").on(
      t.orgId,
      t.earningId,
      t.partIndex,
    ),
    /** The accrual read: one earner's period to date, decomposed. */
    index("idx_crm_commission_accrual_parts_period").on(
      t.orgId,
      t.userId,
      t.periodStart,
      t.earnedOn,
    ),
    /** "What did this deal pay, and to whom?" — the dispute's opening question. */
    index("idx_crm_commission_accrual_parts_source").on(
      t.orgId,
      t.sourceType,
      t.sourceId,
    ),
    /** "What has this version of the plan cost?" — the plan author's question. */
    index("idx_crm_commission_accrual_parts_version").on(
      t.orgId,
      t.planVersionId,
      t.tierIndex,
    ),
    index("idx_crm_commission_accrual_parts_earning").on(t.orgId, t.earningId),
  ],
);

/**
 * The accrued figure as it stood at the end of each day — the curve people watch.
 *
 * Derived from the parts and kept anyway, because the point of continuous
 * accrual is not only that today's number is available but that yesterday's is
 * still what it was yesterday. Recomputing the curve from the ledger on demand
 * would answer "what is the number now, dated back" rather than "what did we
 * tell you on the 14th", and a rep who watched a figure fall would have no way
 * to show that it ever stood higher — a late-arriving deal, a void, or a
 * corrected close date all move history under a recomputed curve.
 *
 * One row per earner, plan, period and day, upserted: the last write on a given
 * day wins, so the curve is end-of-day rather than every intraday flicker.
 * `accrued_minor` always equals the sum of the parts in that period whose
 * `earned_on` falls on or before `as_of_date`, at the moment it was written.
 */
export const crmCommissionAccrualSnapshots = pgTable(
  "crm_commission_accrual_snapshots",
  {
    snapshotId: text("snapshot_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    planId: text("plan_id")
      .references(() => crmCommissionPlans.planId, { onDelete: "restrict" })
      .notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    /** The day this figure was true of. The curve's x axis. */
    asOfDate: date("as_of_date").notNull(),

    /** Commission accrued in the period up to and including `as_of_date`. */
    accruedMinor: bigint("accrued_minor", { mode: "number" }).notNull(),
    /** Basis behind it, so the blended rate is derivable without the parts. */
    basisMinor: bigint("basis_minor", { mode: "number" }).notNull(),
    earningCount: integer("earning_count").default(0).notNull(),
    partCount: integer("part_count").default(0).notNull(),
    /**
     * Attainment at the close of the latest earning counted here.
     *
     * Taken from that earning rather than recomputed, because the quota that
     * produced it lives on an assignment that can since have been re-dated or
     * ended, and a curve point that silently re-bases itself against today's
     * quota is exactly the restatement this table exists to prevent. Null when
     * the plan version carried no quota.
     */
    attainmentBps: integer("attainment_bps"),
    currency: text("currency").notNull(),
    computedAt: timestamp("computed_at").defaultNow().notNull(),
  },
  (t) => [
    /** One point per day; the day's later writes update it in place. */
    uniqueIndex("uniq_crm_commission_accrual_snapshots_day").on(
      t.orgId,
      t.userId,
      t.planId,
      t.periodStart,
      t.asOfDate,
    ),
    /** The curve read: one earner's period, in date order. */
    index("idx_crm_commission_accrual_snapshots_curve").on(
      t.orgId,
      t.userId,
      t.asOfDate,
    ),
    index("idx_crm_commission_accrual_snapshots_plan").on(
      t.orgId,
      t.planId,
      t.periodStart,
    ),
  ],
);
