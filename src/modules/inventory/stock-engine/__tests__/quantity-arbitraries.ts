import fc from "fast-check";

/**
 * T16 — the generators and the exact model the inventory quantity properties
 * are stated against.
 *
 * PRD §12.9 names twelve gate types and asks each for recorded evidence.
 * `property` had none, anywhere in either repository: `fast-check` and
 * `jsverify` returned zero hits in `pnpm-lock.yaml` and no `fc.assert` existed
 * in `src`, `test` or `evals` — while Phase 1's Required-validation list names
 * "quantity property tests" outright.
 *
 * Everything inventory counts, promises, values and posts to the ledger goes
 * through four pure functions: the four `decimal.ts` operators, `availableQty`,
 * `netAvailableQty` and `toBaseQuantity`. They are the correct first target
 * because they are pure, because every one of them is reachable from a document
 * an operator types into, and because their failure mode is silent — a stock
 * figure that is wrong in the fourth decimal place looks exactly like a stock
 * figure that is right.
 *
 * ## The model, and why it is not circular
 *
 * A quantity at scale 4 *is* an integer count of ulps. So the generators build
 * values from a `bigint` and format them, rather than generating text and
 * parsing it back: the expected value of `addDec(a, b)` is known by
 * construction as `a + b` in ulps, never re-derived by calling the code under
 * test.
 *
 * `roundHalfUpAwayFromZero` below is a restatement of the rounding rule
 * `decimal.ts` documents, in a different shape (one expression over signed
 * bigints, rather than an abs/sign dance). It is pinned by hand-written
 * literals in `quantity.property.spec.ts` so it cannot drift into agreeing with
 * a broken implementation. The properties that carry the most weight need no
 * model at all — commutativity, associativity, monotonicity, the availability
 * gates, and the term list being complete — and those are stated first.
 *
 * ## Anti-vacuity
 *
 * A property suite fails open. A generator that only ever emitted `0.0000`
 * would satisfy every law here, and a `numRuns` of 0 would satisfy them without
 * running. `Coverage` records what was actually observed and the spec asserts
 * floors on it in `afterAll`, so a degenerate generator fails rather than
 * passes.
 */

/** Ledger scale: every quantity in `inv_stock_*` is `numeric(_, 4)`. */
export const QTY_UNIT = 10_000n;
/** `inv_product_uom_conversions.factor` is `numeric(18, 6)`. */
export const FACTOR_UNIT = 1_000_000n;

/** The canonical text of a value held as `ulps` at `unit`. */
export function fromUlps(ulps: bigint, unit: bigint = QTY_UNIT): string {
  const negative = ulps < 0n;
  const absolute = negative ? -ulps : ulps;
  const width = unit.toString().length - 1;
  const whole = (absolute / unit).toString();
  const fraction = (absolute % unit).toString().padStart(width, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * `num / den`, rounded half away from zero — the rule both `divRoundHalfUp` in
 * `decimal.ts` and `toBaseQuantity` in `uom-conversion.service.ts` implement.
 * A tie goes away from zero, so `0.5` → `1` and `-0.5` → `-1`.
 */
export function roundHalfUpAwayFromZero(num: bigint, den: bigint): bigint {
  if (den === 0n) return 0n;
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const quotient = a / b;
  const remainder = a % b;
  const rounded = remainder * 2n >= b ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** `-1`, `0` or `1` — the contract `cmpDec` promises. */
export function signOf(value: bigint): number {
  return value < 0n ? -1 : value > 0n ? 1 : 0;
}

/**
 * Ulps across the range inventory actually holds, in three bands so the
 * interesting ones are not drowned by the wide one.
 *
 * A single uniform `bigInt` over eleven digits almost never produces a value
 * whose fractional part matters, and the fractional part is where every
 * rounding defect lives. `small` is sub-unit and sub-ulp-boundary, `typical`
 * is a warehouse count, `wide` reaches the numeric(18,4) column width.
 */
export const qtyUlps: fc.Arbitrary<bigint> = fc.oneof(
  { arbitrary: fc.bigInt({ min: -50_000n, max: 50_000n }), weight: 4 },
  { arbitrary: fc.bigInt({ min: -100_000_000n, max: 100_000_000n }), weight: 3 },
  { arbitrary: fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n }), weight: 1 },
);

/** The same range restricted to zero or more — every bucket on a stock level. */
export const nonNegativeQtyUlps: fc.Arbitrary<bigint> = qtyUlps.map((v) => (v < 0n ? -v : v));

/** A canonical scale-4 decimal string. */
export const decimalString: fc.Arbitrary<string> = qtyUlps.map((v) => fromUlps(v));

/** A conversion factor strictly greater than zero, at `numeric(18, 6)`. */
export const factorUlps: fc.Arbitrary<bigint> = fc.oneof(
  { arbitrary: fc.bigInt({ min: 1n, max: 2_000_000n }), weight: 3 },
  { arbitrary: fc.bigInt({ min: 1n, max: 10n ** 11n }), weight: 1 },
);

export type Ownership = "OWNED" | "VENDOR" | "CUSTOMER";

export interface LevelUlps {
  onHand: bigint;
  committed: bigint;
  blocked: bigint;
  qualityHold: bigint;
  outgoing: bigint;
  isSellable: boolean | null | undefined;
  ownership: Ownership | null | undefined;
}

/**
 * A stock level as integers, with the two gates exercised on purpose.
 *
 * `is_sellable` and `ownership` are both nullable with a permissive default, so
 * `undefined`, `null` and the permissive value must all behave identically —
 * three cases a hand-written test writes one of.
 */
export const levelUlps: fc.Arbitrary<LevelUlps> = fc.record({
  onHand: nonNegativeQtyUlps,
  committed: nonNegativeQtyUlps,
  blocked: nonNegativeQtyUlps,
  qualityHold: nonNegativeQtyUlps,
  outgoing: nonNegativeQtyUlps,
  isSellable: fc.constantFrom<boolean | null | undefined>(true, false, null, undefined),
  ownership: fc.constantFrom<Ownership | null | undefined>("OWNED", "VENDOR", "CUSTOMER", null, undefined),
});

/** The shape `availableQty` takes, built from a `LevelUlps`. */
export function levelInput(level: LevelUlps): {
  on_hand: string;
  committed: string;
  blocked_qty: string | null;
  quality_hold_qty: string | null;
  outgoing_qty: string | null;
  is_sellable?: boolean | null;
  ownership?: Ownership | null;
} {
  return {
    on_hand: fromUlps(level.onHand),
    committed: fromUlps(level.committed),
    blocked_qty: fromUlps(level.blocked),
    quality_hold_qty: fromUlps(level.qualityHold),
    outgoing_qty: fromUlps(level.outgoing),
    is_sellable: level.isSellable,
    ownership: level.ownership,
  };
}

/** True when neither gate withdraws the row from availability. */
export function isPromisable(level: LevelUlps): boolean {
  if (level.isSellable === false) return false;
  return level.ownership === undefined || level.ownership === null || level.ownership === "OWNED";
}

/**
 * What was actually generated, so a degenerate run fails instead of passing.
 *
 * Every counter here is asserted against a floor in `afterAll`. The floors are
 * set below what a healthy run produces and above what a broken generator can:
 * they are there to catch `numRuns: 0`, a constant arbitrary and a filter that
 * rejects everything, not to police the distribution.
 */
export class Coverage {
  private readonly counts = new Map<string, number>();

  observe(label: string, when = true): void {
    if (!when) return;
    this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
  }

  count(label: string): number {
    return this.counts.get(label) ?? 0;
  }

  /** Every label seen at least once, for a failure message that names the gap. */
  summary(): string {
    return [...this.counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, n]) => `${label}=${n}`)
      .join(" ");
  }
}
