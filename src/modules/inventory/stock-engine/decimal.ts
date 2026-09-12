const SCALE = 10000n;

function parseScaled(s: string): bigint {
  const t = s.trim();
  const neg = t.startsWith("-");
  const body = neg || t.startsWith("+") ? t.slice(1) : t;
  const [intPart = "0", fracRaw = ""] = body.split(".");
  const frac5 = (fracRaw + "00000").slice(0, 5);
  let scaled = BigInt(intPart || "0") * SCALE + BigInt(frac5.slice(0, 4) || "0");
  if (Number(frac5[4]) >= 5) scaled += 1n;
  return neg ? -scaled : scaled;
}

function formatScaled(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(4, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den === 0n) return 0n;
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = a / b;
  const r = a % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return neg ? -rounded : rounded;
}

export function addDec(a: string, b: string): string {
  return formatScaled(parseScaled(a) + parseScaled(b));
}

export function subDec(a: string, b: string): string {
  return formatScaled(parseScaled(a) - parseScaled(b));
}

export function mulDec(a: string, b: string): string {
  return formatScaled(divRoundHalfUp(parseScaled(a) * parseScaled(b), SCALE));
}

export function divDec(a: string, b: string): string {
  const bs = parseScaled(b);
  if (bs === 0n) return "0.0000";
  return formatScaled(divRoundHalfUp(parseScaled(a) * SCALE, bs));
}

/** -1 when a < b, 0 when equal, 1 when a > b. Exact — never compare these as floats. */
export function cmpDec(a: string, b: string): number {
  const x = parseScaled(a);
  const y = parseScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Whether `parseScaled` can read this string as a quantity or an amount.
 *
 * Stated here, beside the parser, because a caller that validates input with
 * its own idea of "a number" and then hands the string to this module has two
 * encodings of one rule — and the two disagree in the direction that loses
 * goods. The importer used `parseFloat`, which stops at the first character it
 * cannot read and returns what it has rather than failing: `parseFloat("1,000")`
 * is `1`, and a spreadsheet writes that separator by default. `BigInt` inside
 * `parseScaled` would have thrown on the same string, so the grammar the
 * parser actually accepts is the only safe thing to validate against.
 *
 * Exponent notation is refused deliberately. `parseScaled` cannot read `1e5`,
 * so accepting it here would move the failure from a row error to a raised
 * `SyntaxError` in the middle of a transaction.
 */
export function isDecimalString(a: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(a.trim());
}

export function isNegative(a: string): boolean {
  return parseScaled(a) < 0n;
}

export function isPositive(a: string): boolean {
  return parseScaled(a) > 0n;
}

/**
 * Available to promise at a single stock row. Subtracts every state that is
 * physically present but not sellable — including outgoing_qty, which is picked
 * but not yet shipped and was previously ignored, so it was promised twice.
 */
/**
 * The five terms of availability, named once.
 *
 * A1. There were six independent copies of this arithmetic — four in SQL, two
 * in JavaScript — and not one of them subtracted `outgoing_qty`, so stock that
 * had been picked and was standing on the packing bench was still being
 * promised to the next customer. Copies of a formula do not stay equal; they
 * stay equal until somebody adds a term, and then they are silently different
 * in whichever direction is least visible.
 *
 * The meanings, fixed here so every reader matches:
 *
 *   `committed`     held by an ACTIVE reservation
 *   `outgoing_qty`  picked, and covered by no reservation
 *   `blocked_qty`   administratively blocked
 *   `quality_hold_qty`  held pending inspection
 *
 * `committed` and `outgoing_qty` are disjoint by construction: only the picked
 * quantity a reservation does *not* cover enters `outgoing_qty`. Both are
 * subtracted and neither double-counts the other.
 *
 * The obvious alternative -- move the quantity from `committed` to
 * `outgoing_qty` on pick -- breaks the `committed_vs_reservations`
 * reconciliation check, because `committed` is a projection of ACTIVE
 * reservations and picking does not consume one.
 *
 * `on_order` is deliberately *not* here. Goods on a purchase order are not
 * available to promise — they are not in the building.
 *
 * A2 added a condition rather than a term. Stock standing at a location flagged
 * `is_sellable = false` — the per-warehouse `TRANSIT` location a dispatched
 * transfer parks its goods at — is on hand and is not available, whatever the
 * four terms below say. It is a gate, not a subtraction, so it is not in this
 * list; the list is still the complete set of quantities that are subtracted.
 * The SQL half of the same rule lives in `available-sql.ts`.
 */
export const AVAILABLE_QTY_TERMS = [
  "committed",
  "blocked_qty",
  "quality_hold_qty",
  "outgoing_qty",
] as const;

/**
 * NEO-1 — availability once every *other* sales channel's claim is honoured.
 *
 * `availableQty` answers a question about one stock row: what is physically free
 * where it stands. A channel pool is a claim held above that grain — on a
 * variant, in a warehouse or across the organisation — so it cannot be a term
 * inside the row formula without being subtracted once per row. It is composed
 * here instead, and only here: this is the second half of "availableQty is the
 * only ATP formula", and a caller that writes `available - reserved` itself is
 * the same defect A1 collapsed eight copies of.
 *
 * Clamped at zero. A pool larger than the stock behind it is an over-promise
 * somebody has to unwind, but it is not negative availability — nothing can be
 * promised, and "-2 available" is a number no caller can act on.
 */
export function netAvailableQty(available: string, channelReserved: string | null | undefined): string {
  const net = subDec(available, channelReserved ?? "0");
  return cmpDec(net, "0") < 0 ? "0.0000" : net;
}

export function availableQty(level: {
  on_hand: string;
  committed: string;
  blocked_qty: string | null;
  quality_hold_qty: string | null;
  outgoing_qty: string | null;
  /**
   * Whether the location this row stands at may be sold from. Nullable with a
   * `true` default in the schema, so only an explicit `false` withdraws the
   * stock: absent, null and true all mean sellable, matching the SQL half's
   * `is_sellable IS NOT FALSE`.
   */
  is_sellable?: boolean | null;
  /**
   * NEO-11 - whose stock this is. Absent means `OWNED`, matching the column
   * default: a caller that has not been taught about consignment gets the answer
   * it had before, and only an explicit `VENDOR` or `CUSTOMER` withdraws stock.
   */
  ownership?: "OWNED" | "VENDOR" | "CUSTOMER" | null;
}): string {
  // A2. Goods in transit are on hand and are not for sale. Callers that
  // aggregate across locations before calling this must apply the gate per row,
  // or they will promise a van.
  if (level.is_sellable === false) return "0.0000";

  // NEO-11. Consigned stock is on hand and is not ours. Same shape of gate, same
  // reason it lives here: a term the callers have to remember is a term one of
  // them forgets, and forgetting this one offers a supplier's goods for sale.
  if (level.ownership !== undefined && level.ownership !== null && level.ownership !== "OWNED") {
    return "0.0000";
  }

  return subDec(
    subDec(
      subDec(subDec(level.on_hand, level.committed), level.blocked_qty ?? "0"),
      level.quality_hold_qty ?? "0",
    ),
    level.outgoing_qty ?? "0",
  );
}
