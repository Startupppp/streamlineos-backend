import fc from "fast-check";
import type { availableQty } from "../decimal";

export const QTY_UNIT = 10_000n;
export const FACTOR_UNIT = 1_000_000n;

export type LevelUlps = {
  onHand: bigint;
  committed: bigint;
  blocked: bigint;
  qualityHold: bigint;
  outgoing: bigint;
  isSellable?: boolean | null;
  ownership?: "OWNED" | "VENDOR" | "CUSTOMER" | null;
};

export function fromUlps(ulps: bigint, unit?: bigint): string {
  const u = unit ?? QTY_UNIT;
  const scale = u.toString().length - 1;
  const neg = ulps < 0n;
  const abs = neg ? -ulps : ulps;
  const whole = abs / u;
  const frac = (abs % u).toString().padStart(scale, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

export function roundHalfUpAwayFromZero(num: bigint, den: bigint): bigint {
  if (den === 0n) return 0n;
  const negResult = (num < 0n) !== (den < 0n);
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;
  const q = absNum / absDen;
  const r = absNum % absDen;
  const rounded = r * 2n >= absDen ? q + 1n : q;
  return negResult ? -rounded : rounded;
}

export function signOf(n: bigint): -1 | 0 | 1 {
  if (n < 0n) return -1;
  if (n > 0n) return 1;
  return 0;
}

export function levelInput(level: LevelUlps): Parameters<typeof availableQty>[0] {
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

export function isPromisable(level: LevelUlps): boolean {
  if (level.isSellable === false) return false;
  if (
    level.ownership !== undefined &&
    level.ownership !== null &&
    level.ownership !== "OWNED"
  )
    return false;
  return true;
}

const MAX_QTY = 10n ** 10n;

export const qtyUlps: fc.Arbitrary<bigint> = fc.bigInt({
  min: -MAX_QTY,
  max: MAX_QTY,
});

export const nonNegativeQtyUlps: fc.Arbitrary<bigint> = fc.bigInt({
  min: 0n,
  max: MAX_QTY,
});

export const factorUlps: fc.Arbitrary<bigint> = fc.bigInt({
  min: 1n,
  max: FACTOR_UNIT * 1_000n,
});

export const decimalString: fc.Arbitrary<string> = qtyUlps.map((ulps) =>
  fromUlps(ulps),
);

export const levelUlps: fc.Arbitrary<LevelUlps> = fc
  .record({
    onHand: nonNegativeQtyUlps,
    committed: nonNegativeQtyUlps,
    blocked: nonNegativeQtyUlps,
    qualityHold: nonNegativeQtyUlps,
    outgoing: nonNegativeQtyUlps,
    isSellable: fc.oneof(
      fc.boolean(),
      fc.constant<null>(null),
      fc.constant<undefined>(undefined),
    ),
    ownership: fc.oneof(
      fc.constantFrom<"OWNED" | "VENDOR" | "CUSTOMER">("OWNED", "VENDOR", "CUSTOMER"),
      fc.constant<null>(null),
      fc.constant<undefined>(undefined),
    ),
  });

export class Coverage {
  private readonly counts = new Map<string, number>();

  observe(key: string, flag: boolean = true): void {
    if (flag) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  summary(): string {
    return [...this.counts.entries()]
      .map(([k, v]) => `${k}:${v}`)
      .join(", ");
  }
}
