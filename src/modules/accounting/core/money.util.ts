const SCALE = 4;
const FACTOR = 10000n;

const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function parseToScaled(value: string | undefined): bigint {
  const str = (value ?? "0").trim() || "0";
  if (!DECIMAL_PATTERN.test(str)) {
    throw new Error(`Not a decimal amount: ${JSON.stringify(str)}`);
  }
  const negative = str.startsWith("-");
  const abs = str.replace(/^[+-]/, "");
  const dotIdx = abs.indexOf(".");
  let intPart: string;
  let fracPart: string;
  if (dotIdx === -1) {
    intPart = abs;
    fracPart = "";
  } else {
    intPart = abs.slice(0, dotIdx);
    fracPart = abs.slice(dotIdx + 1);
  }
  const paddedFrac = fracPart.padEnd(SCALE, "0").slice(0, SCALE);
  const scaled = BigInt(intPart || "0") * FACTOR + BigInt(paddedFrac || "0");
  return negative ? -scaled : scaled;
}

function scaledToString(scaled: bigint, dp: number = SCALE): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / FACTOR;
  const fracPart = abs % FACTOR;
  const fracStr = fracPart.toString().padStart(SCALE, "0");
  const truncFrac = fracStr.slice(0, dp);
  const base = `${intPart.toString()}.${truncFrac}`;
  return negative ? `-${base}` : base;
}

function renderRounded(scaled: bigint, dp: number): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const divisor = pow10(Math.max(SCALE - dp, 0));
  const quotient = abs / divisor;
  const remainder = abs % divisor;
  const units = remainder * 2n >= divisor ? quotient + 1n : quotient;
  const unitFactor = pow10(Math.min(dp, SCALE));
  const intPart = units / unitFactor;
  const fracDigits =
    dp === 0
      ? ""
      : (units % unitFactor).toString().padStart(Math.min(dp, SCALE), "0").padEnd(dp, "0");
  const body = dp === 0 ? intPart.toString() : `${intPart.toString()}.${fracDigits}`;
  return negative && units !== 0n ? `-${body}` : body;
}

export function addDecimals(a: string, b: string): string {
  return scaledToString(parseToScaled(a) + parseToScaled(b));
}

export function subtractDecimals(a: string, b: string): string {
  return scaledToString(parseToScaled(a) - parseToScaled(b));
}

export function multiplyDecimals(a: string, b: string): string {
  const sa = parseToScaled(a);
  const sb = parseToScaled(b);
  const product = sa * sb;
  const halfFactor = FACTOR / 2n;
  const negative = product < 0n;
  const absProduct = negative ? -product : product;
  const rounded = (absProduct + halfFactor) / FACTOR;
  const result = negative ? -rounded : rounded;
  return scaledToString(result);
}

export function compareDecimals(a: string, b: string): number {
  const sa = parseToScaled(a);
  const sb = parseToScaled(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export function isZero(a: string): boolean {
  return parseToScaled(a) === 0n;
}

export function formatDecimal(a: string, dp: number = SCALE): string {
  return scaledToString(parseToScaled(a), dp);
}

/**
 * Half-up at `dp`, the rounding a reader expects on a printed statement.
 * `formatDecimal` truncates instead, and several callers depend on that.
 */
export function roundDecimal(a: string, dp: number = 2): string {
  return renderRounded(parseToScaled(a), dp);
}

export function negateDecimal(a: string): string {
  return scaledToString(-parseToScaled(a));
}

export function absDecimal(a: string): string {
  const scaled = parseToScaled(a);
  return scaledToString(scaled < 0n ? -scaled : scaled);
}

/**
 * The boundary conversion. A `numeric` column arrives from the driver as text and
 * every amount below is carried as text; this is the only place a nullable or
 * absent column becomes an amount, so no caller needs `Number(x ?? 0)`.
 */
export function toDecimal(value: string | null | undefined): string {
  if (value === null || value === undefined) return "0.0000";
  const trimmed = value.trim();
  if (trimmed === "") return "0.0000";
  return scaledToString(parseToScaled(trimmed));
}

/**
 * A JSON request body carries money as an IEEE-754 double. Pin it to the ledger's
 * scale exactly once, here, so every later operation is integer arithmetic.
 */
export function decimalFromNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Not a finite amount: ${String(value)}`);
  }
  return scaledToString(parseToScaled(value.toFixed(SCALE)));
}

export function sumDecimals(values: Iterable<string | null | undefined>): string {
  let total = 0n;
  for (const value of values) total += parseToScaled(toDecimal(value));
  return scaledToString(total);
}

export function divideDecimals(a: string, b: string): string {
  const sb = parseToScaled(b);
  if (sb === 0n) throw new Error("Division by zero");
  const numerator = parseToScaled(a) * FACTOR;
  const negative = numerator < 0n !== sb < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = sb < 0n ? -sb : sb;
  const quotient = (absNumerator * 2n + absDenominator) / (absDenominator * 2n);
  return scaledToString(negative ? -quotient : quotient);
}

/**
 * Splits `total` across `weights` so the parts sum to `total` exactly — largest
 * remainder, so the rounding residue lands on the largest shares instead of
 * vanishing. Returns an empty result when the weights carry no magnitude.
 */
export function allocateDecimal(total: string, weights: ReadonlyArray<string>): string[] {
  const scaledTotal = parseToScaled(total);
  const scaledWeights = weights.map((weight) => {
    const value = parseToScaled(weight);
    return value < 0n ? -value : value;
  });
  const weightSum = scaledWeights.reduce((acc, weight) => acc + weight, 0n);
  if (weightSum === 0n) return weights.map(() => "0.0000");

  const negative = scaledTotal < 0n;
  const absTotal = negative ? -scaledTotal : scaledTotal;

  const parts = scaledWeights.map((weight) => {
    const numerator = absTotal * weight;
    return { base: numerator / weightSum, remainder: numerator % weightSum };
  });

  let leftover = absTotal - parts.reduce((acc, part) => acc + part.base, 0n);
  const order = parts
    .map((part, index) => ({ index, remainder: part.remainder }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  for (const entry of order) {
    if (leftover <= 0n) break;
    parts[entry.index].base += 1n;
    leftover -= 1n;
  }

  return parts.map((part) => scaledToString(negative ? -part.base : part.base));
}

export function assertDebitsEqualsCredits(
  lines: ReadonlyArray<{ debit?: string; credit?: string }>,
): void {
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const line of lines) {
    totalDebit += parseToScaled(line.debit ?? "0");
    totalCredit += parseToScaled(line.credit ?? "0");
  }
  if (totalDebit !== totalCredit) {
    throw new Error("Journal entry debits do not equal credits");
  }
}
