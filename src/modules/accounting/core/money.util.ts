const SCALE = 4;
const FACTOR = 10000n;

function parseToScaled(value: string | undefined): bigint {
  const str = (value ?? "0").trim() || "0";
  const negative = str.startsWith("-");
  const abs = negative ? str.slice(1) : str;
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
