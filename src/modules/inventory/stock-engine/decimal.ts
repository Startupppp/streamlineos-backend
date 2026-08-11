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
export function availableQty(level: {
  on_hand: string;
  committed: string;
  blocked_qty: string | null;
  quality_hold_qty: string | null;
  outgoing_qty: string | null;
}): string {
  return subDec(
    subDec(
      subDec(subDec(level.on_hand, level.committed), level.blocked_qty ?? "0"),
      level.quality_hold_qty ?? "0",
    ),
    level.outgoing_qty ?? "0",
  );
}
