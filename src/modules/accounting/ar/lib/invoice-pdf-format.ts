/**
 * Text and number formatting for the tax-invoice PDF: what a standard font can
 * encode, and how minor units, rates and quantities print.
 */
import type { PDFFont } from "pdf-lib";
import { money, toDecimalString } from "../../kernel/money";

/* ------------------------------------------------------------ formatting */

/**
 * WinAnsi is all a standard PDF font can encode, and `drawText` throws on
 * anything else. Customer names are free text, so fold the characters that
 * actually turn up and replace the rest rather than failing to produce an
 * invoice.
 */
const TRANSLITERATE: Record<string, string> = {
  "₹": "Rs.",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
  "•": "-",
};

export function sanitizeForPdf(value: string): string {
  let out = "";
  for (const char of value) {
    const mapped = TRANSLITERATE[char];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code === 9) {
      out += " ";
    } else if (code < 32 || (code >= 127 && code < 160) || code > 255) {
      out += "?";
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Minor units to a display string, through the kernel.
 *
 * A currency the kernel has no scale for would otherwise throw mid-render and
 * lose the whole document; fall back to a two-place scale, still via
 * `toDecimalString`, so this file never performs the division itself.
 */
export function formatMinor(minor: number, currency: string): string {
  try {
    return toDecimalString(money(minor, currency));
  } catch {
    return toDecimalString(money(minor, "USD"));
  }
}

/** 1800 -> "18.00%". Integer maths; basis points are already scaled by 100. */
export function formatRate(rateBp: number): string {
  const negative = rateBp < 0;
  const abs = Math.abs(Math.trunc(rateBp));
  const whole = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}%`;
}

/** Thousandths to a trimmed decimal: 2500 -> "2.5", 1000 -> "1". */
export function formatQuantity(quantityMilli: number): string {
  const negative = quantityMilli < 0;
  const abs = Math.abs(Math.trunc(quantityMilli));
  const whole = Math.trunc(abs / 1000);
  const fraction = String(abs % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = sanitizeForPdf(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // A single word longer than the column is chopped rather than overflowing.
    let remainder = word;
    while (font.widthOfTextAtSize(remainder, size) > maxWidth && remainder.length > 1) {
      let cut = remainder.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(remainder.slice(0, cut), size) > maxWidth) cut--;
      lines.push(remainder.slice(0, cut));
      remainder = remainder.slice(cut);
    }
    current = remainder;
  }
  if (current) lines.push(current);
  return lines;
}
