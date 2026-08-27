import {
  assertMinorUnitRange,
  roundQuotient,
  type RoundingRule,
} from "./money-rounding";

export { ROUNDING_RULES, type RoundingRule } from "./money-rounding";

export interface ProrationInterval {
  periodStart: Date;
  periodEnd: Date;
  effectiveFrom: Date;
  effectiveUntil: Date;
}

export interface ProrationInput extends ProrationInterval {
  oldUnitAmountMinor: number;
  oldQuantity: number;
  newUnitAmountMinor: number;
  newQuantity: number;
  roundingRule: RoundingRule;
}

function assertInterval(interval: ProrationInterval): {
  elapsed: bigint;
  period: bigint;
} {
  const periodStart = interval.periodStart.getTime();
  const periodEnd = interval.periodEnd.getTime();
  const from = interval.effectiveFrom.getTime();
  const until = interval.effectiveUntil.getTime();

  if (periodEnd <= periodStart)
    throw new RangeError("Proration needs a billing period of non-zero length");
  if (until < from)
    throw new RangeError("Proration interval must start before it ends");
  if (from < periodStart || until > periodEnd)
    throw new RangeError("Proration interval falls outside the billing period");

  return {
    elapsed: BigInt(until - from),
    period: BigInt(periodEnd - periodStart),
  };
}

/** For display and reconciliation only — never for money. */
export function prorationFraction(interval: ProrationInterval): number {
  const { elapsed, period } = assertInterval(interval);
  return Number(elapsed) / Number(period);
}

/** Both sides carry a quantity, so a seat change at an unchanged unit price still prorates; negative stays a credit. */
export function computeProrationMinor(input: ProrationInput): number {
  for (const quantity of [input.oldQuantity, input.newQuantity])
    if (!Number.isInteger(quantity) || quantity < 0)
      throw new RangeError("Proration quantity must be a non-negative integer");
  if (
    !Number.isInteger(input.oldUnitAmountMinor) ||
    !Number.isInteger(input.newUnitAmountMinor)
  )
    throw new RangeError("Unit amounts must be integer minor units");

  const { elapsed, period } = assertInterval(input);
  const before = BigInt(input.oldUnitAmountMinor) * BigInt(input.oldQuantity);
  const after = BigInt(input.newUnitAmountMinor) * BigInt(input.newQuantity);
  const numerator = (after - before) * elapsed;

  return assertMinorUnitRange(
    roundQuotient(numerator, period, input.roundingRule),
    "Proration amount",
  );
}
