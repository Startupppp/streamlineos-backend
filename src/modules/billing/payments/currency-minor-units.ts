import { BadRequestException } from "@nestjs/common";

/**
 * ISO 4217 minor-unit exponents, listing only the currencies whose exponent is NOT 2.
 *
 * A payment provider reports an amount in the currency's minor unit, and how many minor
 * units make a major one is a property of the CURRENCY — not a constant 100. Dividing by
 * 100 regardless records a ¥100,000 capture as ¥1,000 (100x understatement) and a
 * KWD 1.234 capture as KWD 12.34 (10x overstatement).
 *
 * Fund and metal codes (XAU, XDR, CLF, UYW, …) are deliberately absent: they are not
 * settleable through a payment gateway, and guessing an exponent for one would be worse
 * than falling through to the default.
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  // Zero-decimal: the minor unit IS the major unit.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Three-decimal: 1000 minor units to the major unit.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** Every currency not listed above, including INR and USD. */
export const DEFAULT_MINOR_UNIT_EXPONENT = 2;

/** How many decimal places one major unit of `currency` has. */
export function minorUnitExponent(currency: string): number {
  return MINOR_UNIT_EXPONENTS[currency.trim().toUpperCase()] ?? DEFAULT_MINOR_UNIT_EXPONENT;
}

/**
 * Converts an integer count of minor units into a major-unit decimal STRING.
 *
 * Pure integer and string arithmetic — no division, so no IEEE-754 double ever holds the
 * amount. The result is the ledger's own carrier type (a decimal string), which is what
 * `ProviderBridgeService` and `money.util.ts` consume.
 *
 * A non-integer input is a contract violation, not something to round: a provider that
 * sent 999.5 minor units either means major units (a 100x error) or is broken. Refusing is
 * the only safe answer for money.
 */
export function minorUnitsToDecimalString(minorUnits: number, currency: string): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new BadRequestException(
      `Provider amount ${String(minorUnits)} is not an integer count of ${currency} minor units`,
    );
  }

  const exponent = minorUnitExponent(currency);
  const sign = minorUnits < 0 ? "-" : "";
  const digits = Math.abs(minorUnits).toString();
  if (exponent === 0) return `${sign}${digits}`;

  const padded = digits.padStart(exponent + 1, "0");
  const split = padded.length - exponent;
  return `${sign}${padded.slice(0, split)}.${padded.slice(split)}`;
}
