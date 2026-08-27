export const ROUNDING_RULES = [
  "HALF_UP",
  "HALF_EVEN",
  "FLOOR",
  "CEILING",
] as const;

export type RoundingRule = (typeof ROUNDING_RULES)[number];

export const INT32_MIN = -2_147_483_648;
export const INT32_MAX = 2_147_483_647;

/** `bigint` because unit × quantity × milliseconds passes `Number.MAX_SAFE_INTEGER` inside ordinary numbers. */
export function roundQuotient(
  numerator: bigint,
  denominator: bigint,
  rule: RoundingRule,
): bigint {
  if (denominator <= 0n)
    throw new RangeError("Rounding denominator must be positive");

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

export function assertMinorUnitRange(amount: bigint, what: string): number {
  if (amount < BigInt(INT32_MIN) || amount > BigInt(INT32_MAX))
    throw new RangeError(
      `${what} ${amount} is out of range for an integer minor-unit column`,
    );
  return Number(amount);
}

/** Tax is a rate in basis points applied to an exact minor-unit amount, so line and document agree by construction. */
export function applyRateBps(
  amountMinor: number,
  rateBps: number,
  rule: RoundingRule,
): number {
  if (!Number.isInteger(amountMinor))
    throw new RangeError("Amount must be an integer minor unit");
  if (!Number.isInteger(rateBps) || rateBps < 0)
    throw new RangeError("Tax rate must be non-negative basis points");
  return assertMinorUnitRange(
    roundQuotient(BigInt(amountMinor) * BigInt(rateBps), 10_000n, rule),
    "Tax amount",
  );
}

export function multiplyMinor(
  unitAmountMinor: number,
  quantity: number,
  what: string,
): number {
  if (!Number.isInteger(unitAmountMinor))
    throw new RangeError("Unit amount must be an integer minor unit");
  if (!Number.isInteger(quantity) || quantity < 0)
    throw new RangeError("Quantity must be a non-negative integer");
  return assertMinorUnitRange(BigInt(unitAmountMinor) * BigInt(quantity), what);
}

export function sumMinor(amounts: number[], what: string): number {
  return assertMinorUnitRange(
    amounts.reduce((total, amount) => total + BigInt(amount), 0n),
    what,
  );
}
