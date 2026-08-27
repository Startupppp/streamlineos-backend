/**
 * A commission plan, dated and versioned.
 *
 * Phase 5, ticket 04. The load-bearing property is that a payout reproduces from
 * the plan **in force when it was earned**, not the current one. A rep who closed
 * a deal in March under a 10% plan is owed 10% of it in December, whatever the
 * plan says by then, and a system that recomputes against the current version
 * quietly rewrites what people were promised.
 *
 * So a plan is a list of versions, each with the date it took effect, and
 * everything downstream asks `versionInForceAt` rather than reading "the plan".
 *
 * Rates are BASIS POINTS — integers — for the reason set out in
 * `commission-accrual.ts`: a percentage stored as 0.1 makes every figure derived
 * from it a float, and money that has been through a float is money somebody has
 * to reconcile by hand.
 */
export interface CommissionRule {
  /**
   * The stage that earns it. A deal earns a rule's rate when it reaches this.
   *
   * Stages, not a bespoke vocabulary: ticket 04 asks for rules "over deals,
   * stage transitions, close dates, owners and splits, all of which already
   * exist", and inventing a second notion of "won" is how two parts of the
   * product come to disagree about whether a deal counts.
   */
  readonly whenStage: string;
  /** Hundredths of a percent. 1000 = 10%. */
  readonly rateBps: number;
  /** Applies only to deal value at or above this, in minor units. */
  readonly minimumDealValueMinor?: number;
}

export interface CommissionPlanVersion {
  readonly version: number;
  /** Inclusive. A deal earned exactly at this instant uses this version. */
  readonly effectiveFrom: Date;
  readonly rules: readonly CommissionRule[];
  /**
   * Set when a version was introduced with an `effectiveFrom` in the past.
   *
   * Ticket 04 permits a retroactive change and asks that it be "explicit and
   * recorded". This is the record: a version whose effect predates its creation
   * carries the reason, and `retroactiveVersions` can list them for anyone
   * asking why a historical payout changed.
   */
  readonly retroactiveReason?: string;
  readonly createdAt: Date;
}

export interface CommissionPlan {
  readonly planId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly versions: readonly CommissionPlanVersion[];
}

export class CommissionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommissionPlanError";
  }
}

/**
 * The version in force at a moment.
 *
 * Returns null rather than falling back to the newest: a deal earned before any
 * version existed has no plan, and answering with today's rules would invent an
 * obligation nobody agreed to.
 */
export function versionInForceAt(
  plan: CommissionPlan,
  at: Date,
): CommissionPlanVersion | null {
  let best: CommissionPlanVersion | null = null;
  for (const version of plan.versions) {
    if (version.effectiveFrom.getTime() > at.getTime()) continue;
    if (!best || version.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = version;
    else if (
      best &&
      version.effectiveFrom.getTime() === best.effectiveFrom.getTime() &&
      version.version > best.version
    ) {
      // Two versions from the same instant: the later-numbered one supersedes.
      best = version;
    }
  }
  return best;
}

/** Every version whose effect predates its creation, with the reason given. */
export function retroactiveVersions(plan: CommissionPlan): readonly CommissionPlanVersion[] {
  return plan.versions.filter(
    (version) => version.effectiveFrom.getTime() < version.createdAt.getTime(),
  );
}

/**
 * The rule a deal earns under, or null when it earns nothing.
 *
 * A deal below every rule's minimum earns nothing, and that is a legitimate
 * answer rather than an error — most deals under a threshold plan earn nothing
 * and the caller should not have to catch for it.
 */
export function ruleFor(
  version: CommissionPlanVersion,
  stage: string,
  dealValueMinor: number,
): CommissionRule | null {
  const candidates = version.rules.filter(
    (rule) =>
      rule.whenStage === stage &&
      dealValueMinor >= (rule.minimumDealValueMinor ?? 0),
  );
  if (candidates.length === 0) return null;

  // The highest minimum the deal clears, so tiered plans read top-down.
  return candidates.reduce((best, rule) =>
    (rule.minimumDealValueMinor ?? 0) > (best.minimumDealValueMinor ?? 0) ? rule : best,
  );
}

/** A plan whose versions are unusable, caught when it is saved rather than when somebody is paid. */
export function assertPlanIsUsable(plan: CommissionPlan): void {
  if (plan.versions.length === 0)
    throw new CommissionPlanError(`plan "${plan.name}" has no versions`);

  const numbers = new Set<number>();
  for (const version of plan.versions) {
    if (numbers.has(version.version))
      throw new CommissionPlanError(`plan "${plan.name}" has two versions numbered ${version.version}`);
    numbers.add(version.version);

    for (const rule of version.rules) {
      if (!Number.isInteger(rule.rateBps) || rule.rateBps < 0 || rule.rateBps > 10_000)
        throw new CommissionPlanError(
          `rate must be whole basis points between 0 and 10000, got ${rule.rateBps}`,
        );
    }
  }
}
