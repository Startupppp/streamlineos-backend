import { cmpDec, isDecimalString } from "../../stock-engine/decimal";

/** One row's worth of complaint, in the shape the importer already reports. */
export interface OpeningStockRowError {
  row: number;
  field: string;
  message: string;
}

/**
 * INV-37 — an opening-stock line, read once and read strictly.
 *
 * `EXPECTED_COLUMNS["opening-stock"]` has always advertised `lotNumber` and
 * `serialNumber`, and `previewImport` has always reported them back to the
 * operator as mapped. Nothing read them: `processOpeningStockRow` built a
 * movement out of the variant and the location alone, so every batch in the
 * file landed on one lot-less, serial-less row. Two batches of one SKU merged —
 * measured at 40 + 15 arriving as a single row of 55 — which is the grain
 * collapse the pack calls corruption, reached through the one door whose entire
 * purpose is loading a warehouse's opening balances in bulk.
 *
 * Reading is kept apart from applying because the two fail differently. A row
 * this file rejects is a row the operator must fix in their spreadsheet, and it
 * is named per field so the error report can point at the cell. A row that
 * applies badly is a stock defect. Putting the first kind here means the
 * importer's validation pass and its apply pass cannot disagree about what the
 * row said — they read it through this one function.
 */
export interface OpeningStockRow {
  sku: string;
  locationCode: string;
  /** Exact, as written in the file. Never round-tripped through a float. */
  quantity: string;
  unitCost: string | null;
  lotNumber: string | null;
  serialNumber: string | null;
}

const text = (value: string | undefined): string => (value ?? "").trim();
const optional = (value: string | undefined): string | null => text(value) || null;

/**
 * The checks, per field, in the order an operator would fix them.
 *
 * Returns every complaint rather than the first, because a row with a bad
 * quantity *and* a bad serial should say both — the importer records only the
 * first, but that is its choice to make and not this function's.
 */
export function validateOpeningStockRow(
  row: Record<string, string>,
  rowIndex: number,
): OpeningStockRowError[] {
  const errors: OpeningStockRowError[] = [];
  const at = (field: string, message: string) => errors.push({ row: rowIndex, field, message });

  if (!text(row["sku"])) at("sku", "sku is required");

  const quantity = text(row["quantity"]);
  if (!quantity) {
    at("quantity", "quantity is required");
  } else if (!isDecimalString(quantity)) {
    // Named rather than generic: "1,000" and "12 cases" are the two forms a
    // spreadsheet actually produces, and both used to import as a number the
    // file never contained.
    at(
      "quantity",
      `quantity must be a plain decimal number — "${quantity}" is not one (no thousands separators, units or exponents)`,
    );
  } else if (cmpDec(quantity, "0") <= 0) {
    at("quantity", "quantity must be a positive number");
  }

  const unitCost = optional(row["unitCost"]);
  if (unitCost !== null) {
    if (!isDecimalString(unitCost)) {
      at("unitCost", `unitCost must be a plain decimal number — "${unitCost}" is not one`);
    } else if (cmpDec(unitCost, "0") < 0) {
      at("unitCost", "unitCost cannot be negative");
    }
  }

  // A serial number identifies one physical unit, so it cannot stand for forty
  // of them. Checked here rather than at the engine because the engine is handed
  // one serial id and a quantity and has no way to know the file claimed both.
  const serialNumber = optional(row["serialNumber"]);
  if (serialNumber !== null && quantity && isDecimalString(quantity) && cmpDec(quantity, "1") !== 0) {
    at(
      "serialNumber",
      `a serial number stands for one unit, so quantity must be 1 — row claims ${quantity} of ${serialNumber}`,
    );
  }

  return errors;
}

/** The row as the applier needs it. Only call after `validateOpeningStockRow` passes. */
export function readOpeningStockRow(row: Record<string, string>): OpeningStockRow {
  return {
    sku: text(row["sku"]),
    locationCode: text(row["locationCode"]),
    quantity: text(row["quantity"]),
    unitCost: optional(row["unitCost"]),
    lotNumber: optional(row["lotNumber"]),
    serialNumber: optional(row["serialNumber"]),
  };
}
