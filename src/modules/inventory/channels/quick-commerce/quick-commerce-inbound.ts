import { BadRequestException } from "@nestjs/common";

/**
 * NEO-2 — the contract a quick-commerce inbound integration has to satisfy.
 *
 * ## What this is, plainly
 *
 * **No Blinkit, Instamart or Zepto account is connected.** There is no supplier
 * portal login, no API key and no mailbox being read. What exists is the
 * *boundary*: the shape of a platform purchase order, three parsers that turn a
 * provider's document into it, and the validation a real one would have to pass.
 * The parsers are exercised against fixtures, and the whole pack is off by
 * default (`inv_settings.pack_quick_commerce`).
 *
 * That is deliberate rather than a shortcut. These platforms publish their
 * supplier formats to onboarded suppliers, not openly; guessing at an endpoint
 * and calling it an integration would produce code that looks connected and is
 * not — the failure `docs/inventory-final-handoff.md` was written about. A
 * parser with a fixture is honest: it says exactly what it can read.
 *
 * ## What a parser may not do
 *
 * Parsers are **pure**. They take bytes and return a `ParsedPlatformPo` or
 * throw. They do not resolve SKUs, they do not touch the database, and they
 * certainly do not post stock — this file imports no engine and no Drizzle.
 * Resolution and validation are `QuickCommerceInboundService`'s, because those
 * need the organisation's catalogue and a parser has no business holding one.
 *
 * ## Where a real adapter's traffic would go
 *
 * Through Composio, in the backend `integrations` module, server-side only
 * (root CLAUDE.md §5) — the same rule the sales-channel adapters follow. A
 * per-tenant provider token must never land in our database.
 */

export const QUICK_COMMERCE_PROVIDERS = ["BLINKIT", "INSTAMART", "ZEPTO"] as const;
export type QuickCommerceProvider = (typeof QUICK_COMMERCE_PROVIDERS)[number];

/** One line of a platform purchase order, exactly as the platform stated it. */
export interface ParsedPlatformPoLine {
  lineOrder: number;
  providerSku: string | null;
  ean: string | null;
  /** Integer minor units, or null when the platform did not state one. */
  mrpPaise: number | null;
  packSize: number | null;
  /** A decimal string. Quantities never become floats on the way in. */
  quantityOrdered: string;
  unitCost: string | null;
}

export interface ParsedPlatformPo {
  provider: QuickCommerceProvider;
  providerPoNumber: string;
  /** The platform's dark store or fulfilment node, as their identifier. */
  destinationRef: string | null;
  orderedAt: Date | null;
  /** `YYYY-MM-DD`, or null. */
  expectedDeliveryDate: string | null;
  currency: string;
  lines: ParsedPlatformPoLine[];
}

export interface QuickCommerceInboundAdapter {
  readonly provider: QuickCommerceProvider;
  /**
   * Turns one provider document into the common shape, or throws
   * `BadRequestException`. Pure: no I/O, no catalogue, no clock beyond what the
   * payload carries.
   */
  parsePurchaseOrder(payload: unknown): ParsedPlatformPo;
}

/* ------------------------------------------------------------------ *
 * Shared parsing helpers
 * ------------------------------------------------------------------ */

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException(`${what}: '${key}' is required`);
  }
  return value.trim();
}

function optionalString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * A quantity as a decimal string, never a float.
 *
 * A platform sending `2.5` as a JSON number is already a float by the time it
 * reaches us, so it is re-rendered through a fixed-precision string rather than
 * carried on as one — the ledger holds `numeric(18,4)` and this is the boundary
 * where the two representations meet.
 */
function decimalString(value: unknown, what: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(4);
  if (typeof value === "string" && /^\d{1,14}(\.\d{1,4})?$/.test(value.trim())) {
    return Number(value.trim()).toFixed(4);
  }
  throw new BadRequestException(`${what} must be a positive quantity`);
}

function optionalDecimalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(4);
  if (typeof value === "string" && /^\d{1,14}(\.\d{1,4})?$/.test(value.trim())) {
    return Number(value.trim()).toFixed(4);
  }
  return null;
}

function optionalInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** `YYYY-MM-DD` or null. A malformed date is dropped rather than guessed at. */
function optionalIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1]! : null;
}

function optionalTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function lineArray(source: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const raw = source[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BadRequestException(`A purchase order must carry at least one '${key}' entry`);
  }
  return raw.map((entry, index) => asRecord(entry, `${key}[${index}]`));
}

/* ------------------------------------------------------------------ *
 * Blinkit
 * ------------------------------------------------------------------ */

/**
 * Blinkit's supplier purchase order, as its published supplier-portal export
 * names its fields. JSON, one order per document, EAN-keyed.
 */
export class BlinkitInboundAdapter implements QuickCommerceInboundAdapter {
  readonly provider = "BLINKIT" as const;

  parsePurchaseOrder(payload: unknown): ParsedPlatformPo {
    const root = asRecord(payload, "Blinkit purchase order");
    return {
      provider: this.provider,
      providerPoNumber: requiredString(root, "po_number", "Blinkit purchase order"),
      destinationRef: optionalString(root, "facility_code") ?? optionalString(root, "store_code"),
      orderedAt: optionalTimestamp(root.po_date),
      expectedDeliveryDate: optionalIsoDate(root.expected_delivery_date),
      currency: optionalString(root, "currency") ?? "INR",
      lines: lineArray(root, "line_items").map((line, index) => ({
        lineOrder: index,
        providerSku: optionalString(line, "item_code"),
        ean: optionalString(line, "ean"),
        mrpPaise: paiseFromRupees(line.mrp),
        packSize: optionalInteger(line.pack_size),
        quantityOrdered: decimalString(line.quantity, `line ${index + 1} quantity`),
        unitCost: optionalDecimalString(line.landing_rate ?? line.unit_price),
      })),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Instamart
 * ------------------------------------------------------------------ */

/** Swiggy Instamart's supplier PO: same shape, different field names. */
export class InstamartInboundAdapter implements QuickCommerceInboundAdapter {
  readonly provider = "INSTAMART" as const;

  parsePurchaseOrder(payload: unknown): ParsedPlatformPo {
    const root = asRecord(payload, "Instamart purchase order");
    return {
      provider: this.provider,
      providerPoNumber: requiredString(root, "purchaseOrderId", "Instamart purchase order"),
      destinationRef: optionalString(root, "darkStoreId"),
      orderedAt: optionalTimestamp(root.createdAt),
      expectedDeliveryDate: optionalIsoDate(root.deliveryBy),
      currency: optionalString(root, "currency") ?? "INR",
      lines: lineArray(root, "items").map((line, index) => ({
        lineOrder: index,
        providerSku: optionalString(line, "skuCode"),
        ean: optionalString(line, "barcode"),
        mrpPaise: paiseFromRupees(line.mrp),
        packSize: optionalInteger(line.caseSize),
        quantityOrdered: decimalString(line.orderedQty, `line ${index + 1} quantity`),
        unitCost: optionalDecimalString(line.basePrice),
      })),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Zepto — the email one
 * ------------------------------------------------------------------ */

const ZEPTO_PO_NUMBER = /^\s*PO\s*(?:number|no\.?|#)\s*[:-]\s*(\S+)/im;
const ZEPTO_STORE = /^\s*(?:store|node|facility)\s*[:-]\s*(.+)$/im;
const ZEPTO_DELIVER_BY = /^\s*(?:deliver\s*by|delivery\s*date)\s*[:-]\s*(\d{4}-\d{2}-\d{2})/im;

/**
 * Zepto's purchase orders arrive as email rather than as an API call, so this
 * reads a CSV block out of a plain-text body.
 *
 * It is heuristic where the JSON parsers are not, and that is why it carries its
 * own settings flag (`qc_zepto_email_po_enabled`) rather than coming on with the
 * pack: "we read a text file and believed it" is a decision an organisation
 * should take deliberately. The parser is strict about what it will accept —
 * a header row naming the columns, and every data row the same width — because
 * a lenient email parser is a way to invent a purchase order out of a signature
 * block.
 */
export class ZeptoEmailInboundAdapter implements QuickCommerceInboundAdapter {
  readonly provider = "ZEPTO" as const;

  parsePurchaseOrder(payload: unknown): ParsedPlatformPo {
    const root = asRecord(payload, "Zepto purchase order");
    const body = requiredString(root, "body", "Zepto purchase order email");

    const poNumber = ZEPTO_PO_NUMBER.exec(body)?.[1];
    if (!poNumber) {
      throw new BadRequestException("Zepto purchase order email: no 'PO number:' line found");
    }

    const rows = csvBlock(body);
    if (rows.length === 0) {
      throw new BadRequestException(
        "Zepto purchase order email: no line-item table found (expected a header row naming sku, ean, qty)",
      );
    }

    const header = rows[0]!.map((cell) => cell.toLowerCase());
    const column = (...names: string[]): number =>
      names.map((name) => header.indexOf(name)).find((index) => index >= 0) ?? -1;

    const skuAt = column("sku", "sku_code", "item");
    const eanAt = column("ean", "barcode");
    const qtyAt = column("qty", "quantity", "ordered_qty");
    const mrpAt = column("mrp");
    const packAt = column("pack", "pack_size", "case_size");
    const rateAt = column("rate", "price", "unit_price");

    if (qtyAt < 0 || (skuAt < 0 && eanAt < 0)) {
      throw new BadRequestException(
        "Zepto purchase order email: the table must name a quantity column and either a sku or an ean column",
      );
    }

    const lines = rows.slice(1).map((row, index) => ({
      lineOrder: index,
      providerSku: skuAt >= 0 ? (row[skuAt]?.trim() || null) : null,
      ean: eanAt >= 0 ? (row[eanAt]?.trim() || null) : null,
      mrpPaise: mrpAt >= 0 ? paiseFromRupees(row[mrpAt]) : null,
      packSize: packAt >= 0 ? optionalInteger(row[packAt]) : null,
      quantityOrdered: decimalString(row[qtyAt], `line ${index + 1} quantity`),
      unitCost: rateAt >= 0 ? optionalDecimalString(row[rateAt]) : null,
    }));

    if (lines.length === 0) {
      throw new BadRequestException("Zepto purchase order email: the table has a header and no rows");
    }

    return {
      provider: this.provider,
      providerPoNumber: poNumber,
      destinationRef: ZEPTO_STORE.exec(body)?.[1]?.trim() ?? null,
      orderedAt: null,
      expectedDeliveryDate: ZEPTO_DELIVER_BY.exec(body)?.[1] ?? null,
      currency: "INR",
      lines,
    };
  }
}

/**
 * The widest run of consecutive comma-separated lines of equal width, with at
 * least two columns and two rows.
 *
 * Taking the widest consistent block rather than "every line with a comma" is
 * what stops an address line or a signature becoming a purchase-order line.
 */
function csvBlock(body: string): string[][] {
  const candidates: string[][][] = [];
  let current: string[][] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const cells = line.split(",").map((cell) => cell.trim());
    const usable = line !== "" && cells.length >= 2;

    if (usable && (current.length === 0 || cells.length === current[0]!.length)) {
      current.push(cells);
      continue;
    }
    if (current.length >= 2) candidates.push(current);
    current = usable ? [cells] : [];
  }
  if (current.length >= 2) candidates.push(current);

  return candidates.sort((a, b) => b.length * b[0]!.length - a.length * a[0]!.length)[0] ?? [];
}

/**
 * Rupees to integer paise, half-up.
 *
 * An MRP is a legal ceiling; a value that arrives as 125.50 and is stored as
 * 125.49999999999999 is not a rounding preference (E3). Parsed from the string
 * form where possible so the float never gets a chance to be wrong.
 */
export function paiseFromRupees(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? value.toString() : typeof value === "string" ? value.trim() : "";
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const rupees = Number(match[1]);
  const paise = Number((match[2] ?? "0").padEnd(2, "0"));
  return rupees * 100 + paise;
}
