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
 *
 * The tables live beside this file, one concern each, and are re-exported here
 * so every importer of `crm/commission` keeps its path:
 *
 *  - `commission-plans.ts` — the rule-set vocabulary, plans, versions and
 *    assignments;
 *  - `commission-earnings.ts` — the earnings ledger;
 *  - `commission-accruals.ts` — the accrual decomposition and its daily curve.
 */
export * from "./commission-plans";
export * from "./commission-earnings";
export * from "./commission-accruals";
