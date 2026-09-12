/**
 * Statement amounts as integer minor units.
 *
 * Amounts land via `fromDecimalString`, which refuses excess precision. A
 * number that is not a clean decimal after the documented cleanup is a
 * rejection, not a `parseFloat`.
 */
import { fromDecimalString, minorUnitsOf, MoneyError } from "../../kernel/money";
import { StatementCsvError } from "./statement-csv-error";

/** Symbols that may sit against a number without changing it. */
const CURRENCY_SYMBOLS = /[₹$€£¥₨₩₪₫₴₺¢₦₱฿]/g;
const WHITESPACE = /\s/g;

export type DecimalSeparator = "." | ",";

/**
 * A CSV cell as integer minor units of `currency`, or `null` when the cell is
 * blank.
 *
 * Handles the shapes real exports use — `1,234.56`, `₹ 1,00,000.00`,
 * `(200.00)`, `500.00 CR`, `INR 42.00`, `1.234,56` under a comma separator —
 * and rejects everything else rather than coercing it. `12abc` is a rejection,
 * not `12`.
 */
export function parseAmountToMinor(
  raw: string,
  currency: string,
  separator: DecimalSeparator = ".",
): number | null {
  const scale = minorUnitsOf(currency);
  let text = raw.replace(WHITESPACE, "");
  if (text === "") return null;

  let negative = false;

  // Accountancy parentheses: (200.00) is minus two hundred.
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }

  text = text.replace(CURRENCY_SYMBOLS, "");

  // A leading or trailing currency/side token, and nothing else alphabetic. A
  // narrow allowlist so `12abc` still fails instead of quietly becoming 12.
  const noise = new Set(["CR", "DR", "RS", "RS.", "INR", currency.toUpperCase()]);
  const leading = /^([A-Za-z]{2,3}\.?)/.exec(text);
  if (leading && noise.has(leading[1].toUpperCase())) {
    if (leading[1].toUpperCase() === "DR") negative = !negative;
    text = text.slice(leading[1].length);
  }
  const trailing = /([A-Za-z]{2,3}\.?)$/.exec(text);
  if (trailing && noise.has(trailing[1].toUpperCase())) {
    if (trailing[1].toUpperCase() === "DR") negative = !negative;
    text = text.slice(0, text.length - trailing[1].length);
  }

  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (text === "") return null;

  // Split on the declared decimal separator, then strip grouping marks from the
  // integer part only — a grouping mark in the fraction is a malformed number.
  const groupingMark = separator === "." ? "," : ".";
  const lastSeparator = text.lastIndexOf(separator);
  const wholeRaw = lastSeparator === -1 ? text : text.slice(0, lastSeparator);
  const fraction = lastSeparator === -1 ? "" : text.slice(lastSeparator + 1);

  if (!isGroupedInteger(wholeRaw, groupingMark)) {
    throw new StatementCsvError(
      `${JSON.stringify(raw)} is not a clean decimal amount. ` +
        `Expected digits with "${separator}" as the decimal mark.`,
    );
  }
  if (fraction !== "" && !/^\d+$/.test(fraction)) {
    throw new StatementCsvError(
      `${JSON.stringify(raw)} is not a clean decimal amount — the fractional part is not numeric.`,
    );
  }
  if (fraction.length > scale) {
    throw new StatementCsvError(
      `${JSON.stringify(raw)} carries ${fraction.length} decimal places but ${currency} has ${scale}.`,
    );
  }

  const whole = wholeRaw.split(groupingMark).join("");
  const decimal = `${negative ? "-" : ""}${whole || "0"}${fraction ? `.${fraction}` : ""}`;

  try {
    return fromDecimalString(decimal, currency).minor;
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new StatementCsvError(`${JSON.stringify(raw)} is not a valid ${currency} amount: ${error.message}`);
    }
    throw error;
  }
}

/** `1,00,000` and `1,234,567` pass; `1,,2`, `,12`, `12,` and `12a` do not. */
function isGroupedInteger(value: string, groupingMark: string): boolean {
  if (value === "") return true;
  if (value.startsWith(groupingMark) || value.endsWith(groupingMark)) return false;
  const groups = value.split(groupingMark);
  return groups.every((g) => g.length > 0 && /^\d+$/.test(g));
}
