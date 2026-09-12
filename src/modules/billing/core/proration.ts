/**
 * What an upgrade costs mid-cycle, and what a downgrade is worth.
 *
 * Phase 3 ticket 15. Growing should not be punished by timing: a customer who
 * upgrades on day twenty pays for the eleven days they get, not a second full
 * month, and the eleven days they already paid for on the old plan come off.
 *
 * Pure and integer throughout. Proration is the arithmetic customers check by
 * hand, and it is the arithmetic a floating-point rate makes indefensible -- a
 * charge of 1234.5000000001 minor units is not a charge, it is an argument.
 *
 * Days rather than seconds, deliberately. A customer can reconstruct "eleven of
 * thirty days" on paper; they cannot reconstruct a second-precision fraction,
 * and a proration nobody can check is one they dispute.
 */

export interface Period {
  readonly start: Date;
  readonly end: Date;
}

export interface ProrationInput {
  readonly period: Period;
  /** When the change takes effect. Clamped into the period. */
  readonly changeAt: Date;
  /** Integer minor units for the whole period. */
  readonly oldPlanAmountMinor: number;
  readonly newPlanAmountMinor: number;
}

export interface Proration {
  readonly totalDays: number;
  readonly remainingDays: number;
  /** What the unused remainder of the old plan is worth. */
  readonly creditMinor: number;
  /** What the remainder of the new plan costs. */
  readonly chargeMinor: number;
  /**
   * What to actually bill. Negative means a credit is owed.
   *
   * Kept as one number because that is what appears on the invoice, and two
   * numbers that must be subtracted somewhere else is how the subtraction gets
   * done twice.
   */
  readonly netMinor: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two instants, floored — a partial day is not a day. */
function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

export function prorate(input: ProrationInput): Proration {
  const { period, oldPlanAmountMinor, newPlanAmountMinor } = input;

  const totalDays = daysBetween(period.start, period.end);
  if (totalDays <= 0)
    throw new Error(
      "[proration] the billing period must span at least one whole day. " +
        "A zero-day period makes every proration a division by zero.",
    );

  // Clamped rather than trusted. A change dated before the period starts would
  // credit more than was paid; one dated after it ends would charge for days
  // that are not in it.
  const changeAt = new Date(
    Math.min(Math.max(input.changeAt.getTime(), period.start.getTime()), period.end.getTime()),
  );

  const remainingDays = daysBetween(changeAt, period.end);

  // Each side rounds once, against the whole-period amount. Computing a daily
  // rate and multiplying rounds twice, and the second rounding is where the
  // customer's arithmetic stops matching ours.
  const creditMinor = Math.round((oldPlanAmountMinor * remainingDays) / totalDays);
  const chargeMinor = Math.round((newPlanAmountMinor * remainingDays) / totalDays);

  return {
    totalDays,
    remainingDays,
    creditMinor,
    chargeMinor,
    netMinor: chargeMinor - creditMinor,
  };
}

/**
 * What a downgrade removes, stated before it happens.
 *
 * A cheaper plan should not be a surprise outage. This answers "what do I lose",
 * which is the question a customer actually has, rather than "what does it
 * cost", which they can already see.
 */
export interface DowngradeImpact<TKey extends string = string> {
  /** Limits that would be exceeded immediately on the new plan. */
  readonly exceeded: readonly { key: TKey; current: number; newLimit: number }[];
  /** Whether anything would break the moment the change applied. */
  readonly isBlocking: boolean;
}

export function downgradeImpact<TKey extends string>(
  current: Readonly<Record<TKey, number>>,
  newLimits: Readonly<Record<TKey, number>>,
): DowngradeImpact<TKey> {
  const exceeded = (Object.keys(newLimits) as TKey[])
    .filter((key) => {
      const limit = newLimits[key];
      // A negative limit is the convention for unlimited; it can never be
      // exceeded, and treating it as zero would block every downgrade.
      return limit >= 0 && (current[key] ?? 0) > limit;
    })
    .map((key) => ({ key, current: current[key] ?? 0, newLimit: newLimits[key] }));

  return { exceeded, isBlocking: exceeded.length > 0 };
}
