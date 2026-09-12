/**
 * G5 — spreading one charge across many cost layers without losing a fraction.
 *
 * Two properties matter and they fight each other. Every share must be
 * representable in the column it lands in — `numeric(18,4)`, so four decimals
 * and no more — and the shares must add back up to the charge exactly. Dividing
 * ₹100 of freight across three layers of equal value gives 33.3333 three times,
 * which is 99.9999. The missing 0.0001 has to go somewhere, and "somewhere" has
 * to be a rule rather than whichever layer the loop happened to finish on.
 *
 * The rule here is **largest remainder**. Each share is floored to the 1/10000
 * grain, which leaves a whole number of grains undistributed; those go one
 * apiece to the layers whose exact share was cut by the most, largest shortfall
 * first. Ties break on the larger weight, then the lower id — both stable
 * properties of the input, so the same voucher apportioned twice gives the same
 * answer on any machine, in any row order the database returns.
 *
 * Everything below is `bigint` at a fixed scale of 10^4. There is no `Number` in
 * this file and no `parseFloat` anywhere near it: money and quantity are the two
 * values the PRD forbids floats for, and an apportionment is where a binary
 * fraction would be least visible and most expensive — it would not fail, it
 * would just stop adding up, by an amount too small to notice per row and
 * exactly large enough to leave a valuation report disagreeing with itself.
 *
 * The scale matches `decimal.ts`, whose helpers this module uses everywhere
 * except here. They are not enough on their own: largest remainder needs the
 * quotient *and* the remainder of one division, and `divDec` returns a rounded
 * quotient with the remainder already thrown away.
 */

const SCALE = 10000n;

/** A 4-decimal string as an exact integer count of 1/10000ths. */
export function toScaled(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const body = negative || trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  const [whole = "0", fractionRaw = ""] = body.split(".");
  // A fifth decimal is rounded half-up rather than truncated, matching
  // `decimal.ts`, so a value that has been through both agrees with itself.
  const fraction = (fractionRaw + "00000").slice(0, 5);
  let scaled = BigInt(whole || "0") * SCALE + BigInt(fraction.slice(0, 4) || "0");
  if (Number(fraction[4]) >= 5) scaled += 1n;
  return negative ? -scaled : scaled;
}

/** The inverse: an exact integer count of 1/10000ths as a 4-decimal string. */
export function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / SCALE;
  const fraction = (magnitude % SCALE).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

/**
 * Integer minor units — cents, paise — as the 4-decimal string the valuation
 * tables are kept in. Exact in both directions: one cent is 0.0100, and no
 * rounding decision is taken, which is why money may stay integer everywhere it
 * is stored and still be apportioned at the grain layers use.
 */
export function centsToDecimal(cents: bigint): string {
  return fromScaled(cents * 100n);
}

export interface ApportionTarget {
  /** Stable tie-break, and what the caller matches the share back to. */
  readonly id: number;
  /** Non-negative, in whatever basis the voucher chose. 4-decimal string. */
  readonly weight: string;
}

export interface ApportionShare {
  readonly id: number;
  /** 4-decimal string. The shares sum to `total` exactly. */
  readonly amount: string;
}

/**
 * Splits `total` across `targets` in proportion to their weights.
 *
 * Throws when the weights sum to zero and there is something to spread: there
 * is no defensible answer — spreading equally would invent a basis nobody chose,
 * and returning zeros would silently lose the whole charge. The caller is
 * expected to have refused that case with a message naming the basis; this is
 * the backstop, not the check.
 */
export function apportion(
  total: string,
  targets: readonly ApportionTarget[],
): ApportionShare[] {
  const totalScaled = toScaled(total);
  if (targets.length === 0) {
    if (totalScaled === 0n) return [];
    throw new RangeError("Cannot apportion a non-zero total across no targets");
  }

  const weights = targets.map((target) => {
    const weight = toScaled(target.weight);
    if (weight < 0n)
      throw new RangeError(`Apportionment weight for ${target.id} is negative`);
    return weight;
  });
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);

  if (weightTotal === 0n) {
    if (totalScaled === 0n)
      return targets.map((target) => ({ id: target.id, amount: fromScaled(0n) }));
    throw new RangeError("Cannot apportion against weights that sum to zero");
  }

  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let distributed = 0n;
  for (const weight of weights) {
    const numerator = totalScaled * weight;
    const share = numerator / weightTotal;
    floors.push(share);
    remainders.push(numerator % weightTotal);
    distributed += share;
  }

  // A whole number of 1/10000ths, strictly fewer than there are targets.
  let leftover = totalScaled - distributed;

  const order = targets
    .map((target, index) => ({ index, id: target.id, remainder: remainders[index]!, weight: weights[index]! }))
    .sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      if (a.weight !== b.weight) return a.weight > b.weight ? -1 : 1;
      return a.id - b.id;
    });

  for (const entry of order) {
    if (leftover <= 0n) break;
    floors[entry.index] = floors[entry.index]! + 1n;
    leftover -= 1n;
  }

  return targets.map((target, index) => ({
    id: target.id,
    amount: fromScaled(floors[index]!),
  }));
}

export interface RemainingSplit {
  /** The share belonging to units still in stock — the part that may capitalise. */
  readonly capitalisable: string;
  /** The share belonging to units already issued — a period cost, not inventory. */
  readonly expensed: string;
}

/**
 * Divides one layer's allocation between the units still standing in the
 * warehouse and the units that have already left.
 *
 * This is the arithmetic behind the answer to "the freight bill arrived after
 * the goods". Cost that reaches a layer is only ever recovered when that layer
 * is issued, so freight attributable to units already issued can never be
 * recovered — putting it into the layer would overstate the remaining stock and
 * understate the cost of the sale that has already happened. It is expensed
 * instead.
 *
 * The odd 1/10000th goes to the expensed side. That is the conservative
 * direction — capitalising defers cost into the balance sheet, expensing takes
 * it now — and it is one stated rule rather than a judgement made per layer.
 */
export function splitByRemaining(
  allocated: string,
  remainingQuantity: string,
  layerQuantity: string,
): RemainingSplit {
  const allocatedScaled = toScaled(allocated);
  const remaining = toScaled(remainingQuantity);
  const quantity = toScaled(layerQuantity);

  if (quantity <= 0n || remaining <= 0n)
    return { capitalisable: fromScaled(0n), expensed: fromScaled(allocatedScaled) };
  if (remaining >= quantity)
    return { capitalisable: fromScaled(allocatedScaled), expensed: fromScaled(0n) };

  // Truncating division: the floor lands on the capitalisable side and the
  // remainder, by subtraction, on the expensed side.
  const capitalisable = (allocatedScaled * remaining) / quantity;
  return {
    capitalisable: fromScaled(capitalisable),
    expensed: fromScaled(allocatedScaled - capitalisable),
  };
}
