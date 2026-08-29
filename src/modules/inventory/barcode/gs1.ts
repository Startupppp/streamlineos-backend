/**
 * INV-203 — GS1 element string parsing, for the subset inventory needs.
 *
 * A scanner hands over one string. Whether that string is a plain SKU or a
 * GS1-128 element string carrying a GTIN, a batch, an expiry and a serial is
 * something only its shape can tell you, and getting it wrong quietly is the
 * failure that matters: a mis-split element string yields a *plausible* lot
 * number, and plausible wrong data in a traceability record is worse than a
 * refusal.
 *
 * The three things this gets right, because they are the three usually got
 * wrong:
 *
 *   **Fixed-length AIs carry no separator.** `01` is always 14 digits and runs
 *   straight into whatever follows. Splitting on the group separator alone
 *   loses every element that came after a fixed-length one.
 *
 *   **Variable-length AIs end at FNC1 or at the end of the string** — never at
 *   a fixed count. `10` (batch) may be 1 to 20 characters, so a batch of
 *   "0000" followed by more data is distinguishable only by the separator.
 *
 *   **A GS1 date of `YYMM00` means the end of that month**, not the zeroth day.
 *   Read literally it is an invalid date, and an expiry that fails to parse is
 *   an expiry that stops blocking anything.
 *
 * Anything outside the known set is preserved verbatim as an unparsed segment
 * rather than guessed at, and the raw scan always travels with the
 * interpretation, because a traceability record has to be able to show what the
 * scanner actually read.
 */

/** ASCII group separator — FNC1 in a transmitted GS1 element string. */
const GS = "\x1D";

/**
 * The AIs this module claims to understand, with their fixed data length where
 * the standard defines one. Everything else is variable length and runs to the
 * next separator.
 */
const FIXED_LENGTH: Record<string, number> = {
  "00": 18, // SSCC
  "01": 14, // GTIN
  "02": 14, // GTIN of contained trade items
  "11": 6, // production date
  "12": 6, // due date
  "13": 6, // packaging date
  "15": 6, // best before
  "16": 6, // sell by
  "17": 6, // expiry
  "20": 2, // variant
};

const DATE_AIS = new Set(["11", "12", "13", "15", "16", "17"]);

export interface Gs1ParseResult {
  /** Exactly what the scanner sent, before any interpretation. */
  raw: string;
  /** True when the payload actually parsed as a GS1 element string. */
  isGs1: boolean;
  gtin?: string;
  lotNumber?: string;
  serialNumber?: string;
  /** ISO `YYYY-MM-DD`. */
  expiryDate?: string;
  productionDate?: string;
  bestBeforeDate?: string;
  /** Every AI found, including ones with no dedicated field above. */
  elements: Array<{ ai: string; value: string }>;
  /** Data that could not be attributed to an AI. */
  unparsed?: string;
}

/**
 * `YYMMDD` to ISO. The century window is the one GS1 specifies: a year more
 * than 50 ahead is read as the past.
 */
export function parseGs1Date(value: string): string | undefined {
  if (!/^\d{6}$/.test(value)) return undefined;
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const dd = Number(value.slice(4, 6));
  if (mm < 1 || mm > 12) return undefined;

  const nowYy = new Date().getUTCFullYear() % 100;
  const century = yy - nowYy > 50 ? -1 : yy - nowYy < -50 ? 1 : 0;
  const year =
    Math.floor(new Date().getUTCFullYear() / 100) * 100 + yy + century * 100;

  // Day 00 means the last day of the month, not day zero.
  const day = dd === 0 ? new Date(Date.UTC(year, mm, 0)).getUTCDate() : dd;
  if (day < 1 || day > 31) return undefined;

  const iso = `${String(year).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function stripSymbologyIdentifier(payload: string): string {
  // Some wedges transmit the AIM identifier (]C1, ]d2, ]e0) ahead of the data.
  return /^\][A-Za-z]\d/.test(payload) ? payload.slice(3) : payload;
}

export function parseGs1(payload: string): Gs1ParseResult {
  const raw = payload;
  let body = stripSymbologyIdentifier(payload.trim());
  // A leading FNC1 is structural, not data.
  while (body.startsWith(GS)) body = body.slice(1);

  const elements: Array<{ ai: string; value: string }> = [];
  let cursor = 0;
  let unparsed: string | undefined;

  while (cursor < body.length) {
    if (body[cursor] === GS) {
      cursor += 1;
      continue;
    }
    const ai2 = body.slice(cursor, cursor + 2);
    if (!/^\d{2}$/.test(ai2)) {
      unparsed = body.slice(cursor);
      break;
    }

    const fixed = FIXED_LENGTH[ai2];
    if (fixed !== undefined) {
      const value = body.slice(cursor + 2, cursor + 2 + fixed);
      if (value.length < fixed) {
        unparsed = body.slice(cursor);
        break;
      }
      elements.push({ ai: ai2, value });
      cursor += 2 + fixed;
      continue;
    }

    // Variable length: run to the next separator, or to the end.
    const rest = body.slice(cursor + 2);
    const end = rest.indexOf(GS);
    const value = end === -1 ? rest : rest.slice(0, end);
    if (value.length === 0) {
      unparsed = body.slice(cursor);
      break;
    }
    elements.push({ ai: ai2, value });
    cursor += 2 + value.length + (end === -1 ? 0 : 1);
  }

  const byAi = new Map(elements.map((e) => [e.ai, e.value]));
  const dateOf = (ai: string) => {
    const value = byAi.get(ai);
    return value && DATE_AIS.has(ai) ? parseGs1Date(value) : undefined;
  };

  // Without a GTIN this is a plain barcode that happens to start with digits,
  // not a GS1 element string. Claiming otherwise invents a lot number out of a
  // product code.
  const isGs1 = elements.length > 0 && byAi.has("01");

  return {
    raw,
    isGs1,
    gtin: byAi.get("01"),
    lotNumber: byAi.get("10"),
    serialNumber: byAi.get("21"),
    expiryDate: dateOf("17"),
    productionDate: dateOf("11"),
    bestBeforeDate: dateOf("15"),
    elements,
    ...(unparsed ? { unparsed } : {}),
  };
}

/** The elements a printed label may carry, before they become an element string. */
export interface Gs1LabelElements {
  /** GTIN as held on the variant. Shorter forms are zero-padded to 14. */
  gtin?: string | null;
  lotNumber?: string | null;
  /** ISO `YYYY-MM-DD`. */
  expiryDate?: string | null;
  serialNumber?: string | null;
}

/**
 * G4 — the inverse of `parseGs1`, for the label this module has to print.
 *
 * Written here rather than in the label module for one reason: an encoder and a
 * decoder that live apart drift apart, and the failure is silent both ways — a
 * label the warehouse's own scanner cannot read, or worse, one it reads as a
 * different lot. Sitting beside the parser, the round trip is a unit test rather
 * than a hope.
 *
 * Two rules from the standard decide the ordering, and both are the ones usually
 * got wrong:
 *
 *   **Fixed-length AIs are emitted first and carry no separator.** `01` is always
 *   14 digits and `17` always 6, so a reader consumes them by count. Putting a
 *   variable-length element between two fixed ones would force a separator where
 *   readers do not expect one.
 *
 *   **Variable-length AIs are separated by FNC1, except the last.** A trailing
 *   separator is legal but pointless, and some encoders emit it as literal data.
 *
 * Returns null when there is no GTIN: without one this is not a GS1 element
 * string, and `parseGs1` would rightly refuse to read it as one — printing
 * `10LOT-1` alone would produce a label that scans as the plain text "10LOT-1".
 */
export function formatGs1(elements: Gs1LabelElements): string | null {
  const gtin = normaliseGtin(elements.gtin);
  if (!gtin) return null;

  let out = `01${gtin}`;

  const expiry = formatGs1Date(elements.expiryDate);
  if (expiry) out += `17${expiry}`;

  const variable: string[] = [];
  const lot = (elements.lotNumber ?? "").trim();
  if (lot) variable.push(`10${lot.slice(0, 20)}`);
  const serial = (elements.serialNumber ?? "").trim();
  if (serial) variable.push(`21${serial.slice(0, 20)}`);

  return out + variable.join(GS);
}

/** ISO `YYYY-MM-DD` to the `YYMMDD` the standard transmits. */
export function formatGs1Date(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return undefined;
  return `${match[1]!.slice(2)}${match[2]}${match[3]}`;
}

/**
 * A GTIN is 14 digits in an element string, whatever length it is printed at.
 * An EAN-13 or a UPC-A is the same number with leading zeros, so padding is the
 * conversion rather than an approximation of one. Anything non-numeric is not a
 * GTIN — a SKU sitting in the barcode column is common and must not be dressed
 * up as one.
 */
function normaliseGtin(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").trim();
  if (!/^\d{8,14}$/.test(digits)) return null;
  return digits.padStart(14, "0");
}
