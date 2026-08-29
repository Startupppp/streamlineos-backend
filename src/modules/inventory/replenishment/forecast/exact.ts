/**
 * C1 — where the float ends and the exact number begins.
 *
 * This tree does two different kinds of arithmetic and they need different
 * number types, so the boundary between them is named here rather than being
 * re-decided at every call site.
 *
 * **Exact, always.** A ledger quantity and a money amount are `numeric(18,4)`
 * in Postgres. Eighteen significant digits do not fit in a float64 mantissa, and
 * even where they do, `0.1 + 0.2` is the wrong answer to a question about how
 * many units are on a shelf. So on-hand, committed, on-order, available, a
 * reorder point, a shortfall, an order quantity, a unit cost and a line value
 * are decimal strings from the moment they leave Postgres to the moment they are
 * written back or serialised, and every operation on them goes through
 * `addDec`/`subDec`/`mulDec`/`divDec`/`cmpDec` in `stock-engine/decimal.ts`.
 * **`parseFloat` on any of them is banned.**
 *
 * **Float, deliberately.** A mean, a sample standard deviation, an ADI, a CV²,
 * an autocorrelation, an exponential-smoothing constant, an inverse-normal
 * z-score and √(L·σ_d² + d̄²·σ_L²) are estimates of a distribution. They are
 * floating-point mathematics by nature, nobody owns them, and grinding them
 * through 4-decimal string arithmetic would cost real time while *implying* a
 * precision the sample does not have. Forcing them into decimals would be
 * cargo-cult, not rigour.
 *
 * The two functions below are the only crossings. `fromExact` is where an exact
 * quantity becomes an input to statistics; `toExact` is where a statistic stops
 * being an estimate and becomes a quantity that is stored in a column or shown
 * to a human. Everything in between stays on its own side.
 */
import { cmpDec } from "../../stock-engine/decimal";

/** The scale of every quantity column in this module: `numeric(18, 4)`. */
const SCALE_DIGITS = 4;

/**
 * Statistic → quantity. The one place a float is allowed to become a number
 * somebody will act on, so it rounds once, explicitly, to the column's scale.
 *
 * A non-finite input is a bug upstream (a division by a zero sample, usually).
 * It becomes `"0.0000"` rather than `"NaN"`, because `NaN` written to a
 * `numeric` column fails the insert at 2am and `"NaN"` shown to a planner is
 * worse than a zero next to the caveat that explains it.
 */
export function toExact(value: number): string {
  if (!Number.isFinite(value)) return "0.0000";
  // `toFixed` switches to exponential notation above 1e21, which Postgres will
  // accept but no reader will. Nothing in inventory is that large; clamp rather
  // than emit something unreadable.
  const clamped = Math.max(-1e18, Math.min(1e18, value));
  return clamped.toFixed(SCALE_DIGITS);
}

/**
 * Quantity → statistic. Named so the crossing is greppable: every float in the
 * estimators can be traced back to one of these calls.
 */
export function fromExact(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The larger of two exact quantities. Comparison is `cmpDec`, never `>`. */
export function maxExact(a: string, b: string): string {
  return cmpDec(a, b) >= 0 ? a : b;
}

/** Clamped at zero. A negative quantity is almost always a subtraction that ran past its floor. */
export function atLeastZero(value: string): string {
  return maxExact(value, "0.0000");
}

/** True when the exact value is strictly greater than zero. */
export function isPositiveExact(value: string): boolean {
  return cmpDec(value, "0") > 0;
}
