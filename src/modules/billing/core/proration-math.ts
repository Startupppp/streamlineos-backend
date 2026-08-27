export const ROUNDING_RULES = ["HALF_UP", "HALF_EVEN", "FLOOR", "CEILING"] as const;

export type RoundingRule = (typeof ROUNDING_RULES)[number];

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

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

function assertInterval(interval: ProrationInterval): { elapsed: bigint; period: bigint } {
  const periodStart = interval.periodStart.getTime();
  const periodEnd = interval.periodEnd.getTime();
  const from = interval.effectiveFrom.getTime();
  const until = interval.effectiveUntil.getTime();

  if (periodEnd <= periodStart) throw new RangeError("Proration needs a billing period of non-zero length");
  if (until < from) throw new RangeError("Proration interval must start before it ends");
  if (from < periodStart || until > periodEnd)
    throw new RangeError("Proration interval falls outside the billing period");

  return { elapsed: BigInt(until - from), period: BigInt(periodEnd - periodStart) };
}

/** The share of the billing period the change applies to, for display and reconciliation only — never for money. */
export function prorationFraction(interval: ProrationInterval): number {
  const { elapsed, period } = assertInterval(interval);
  return Number(elapsed) / Number(period);
}

/**
 * Rounds an exact rational to an integer minor unit. Money never touches a float:
 * the numerator is a `bigint` because unit × quantity × milliseconds passes
 * `Number.MAX_SAFE_INTEGER` well inside ordinary enterprise numbers.
 */
function divideRounded(numerator: bigint, denominator: bigint, rule: RoundingRule): bigint {
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;

  if (remainder === 0n) return negative ? -quotient : quotient;

  const twiceRemainder = remainder * 2n;
  let rounded: bigint;

  switch (rule) {
    case "HALF_UP":
      rounded = twiceRemainder >= denominator ? quotient + 1n : quotient;
      break;
    case "HALF_EVEN":
      if (twiceRemainder > denominator) rounded = quotient + 1n;
      else if (twiceRemainder < denominator) rounded = quotient;
      else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    case "FLOOR":
      rounded = negative ? quotient + 1n : quotient;
      break;
    case "CEILING":
      rounded = negative ? quotient : quotient + 1n;
      break;
  }

  return negative ? -rounded : rounded;
}

/**
 * The signed minor-unit adjustment for moving from one priced quantity to another
 * part way through a billing period. Both sides carry their own quantity, so a
 * seat-count change at an unchanged unit price prorates like a price change does.
 * Negative is a credit, and it stays a credit — the sign is the fact, never a
 * caller's convention.
 */
export function computeProrationMinor(input: ProrationInput): number {
  for (const quantity of [input.oldQuantity, input.newQuantity])
    if (!Number.isInteger(quantity) || quantity < 0)
      throw new RangeError("Proration quantity must be a non-negative integer");
  if (!Number.isInteger(input.oldUnitAmountMinor) || !Number.isInteger(input.newUnitAmountMinor))
    throw new RangeError("Unit amounts must be integer minor units");

  const { elapsed, period } = assertInterval(input);
  const before = BigInt(input.oldUnitAmountMinor) * BigInt(input.oldQuantity);
  const after = BigInt(input.newUnitAmountMinor) * BigInt(input.newQuantity);
  const numerator = (after - before) * elapsed;
  const amount = divideRounded(numerator, period, input.roundingRule);

  if (amount < BigInt(INT32_MIN) || amount > BigInt(INT32_MAX))
    throw new RangeError(`Proration amount ${amount} is out of range for an integer minor-unit column`);

  return Number(amount);
}
