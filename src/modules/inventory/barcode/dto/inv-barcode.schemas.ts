import { z } from "zod";

export const barcodeScanSchema = z.object({
  /**
   * The scanner's payload, verbatim. Not trimmed of separators here -- FNC1 is
   * structure the parser needs, and a boundary that helpfully strips it turns a
   * multi-element label into one long lot number.
   */
  payload: z.string().min(1).max(500),
}).strict();
export type BarcodeScanInput = z.infer<typeof barcodeScanSchema>;

export const barcodeLookupSchema = z.object({
  code: z.string().trim().min(1).max(200),
}).strict();
export type BarcodeLookupInput = z.infer<typeof barcodeLookupSchema>;

export type BarcodeLookupResult =
  | { type: "product"; productId: number; name: string; sku: string; status: string; totalOnHand: string }
  | { type: "variant"; variantId: number; productId: number; name: string; sku: string; isActive: boolean; totalOnHand: string }
  | { type: "lot"; lotId: number; variantId: number; lotNumber: string; status: string }
  | { type: "serial"; serialId: number; variantId: number; serialNumber: string; status: string; currentLocationId: number | null }
  | { type: "location"; locationId: number; warehouseId: number; name: string; code: string; locationType: string; isActive: boolean }
  | { type: "not_found" };

export interface ScanResult {
  parsed: import("../gs1").Gs1ParseResult;
  variant?: {
    id: number;
    productId: number;
    name: string;
    sku: string;
    isActive: boolean;
  } | null;
  lot?: {
    id: number;
    productVariantId: number;
    lotNumber: string;
    status: string;
    expiryDate: string | null;
  } | null;
  serial?: {
    id: number;
    productVariantId: number;
    serialNumber: string;
    status: string;
    currentLocationId: number | null;
  } | null;
  /** Present only when the payload was not a GS1 element string. */
  lookup?: BarcodeLookupResult;
  /** Things that resolved but disagree. Never silently dropped. */
  warnings: string[];
}

/**
 * G4 — what goes on a printed label.
 *
 * `code` is the load-bearing field: it is the value `GET /inventory/barcode/lookup`
 * resolves, so a label carrying it can always be scanned back to the goods it
 * came off. `gs1` is the richer element string beside it, which `POST
 * /inventory/barcode/scan` reads — it exists only where the variant has a real
 * GTIN, because a GS1 string without one is not a GS1 string.
 */
export interface LabelPayload {
  productVariantId: number;
  productId: number;
  productName: string;
  variantName: string;
  sku: string;
  /** Resolvable by the lookup endpoint. */
  code: string;
  /** Which column `code` came from, so a printer can pick a symbology. */
  codeSource: "barcode" | "sku";
  uom: string | null;
  lot: {
    lotId: number;
    lotNumber: string;
    expiryDate: string | null;
    manufactureDate: string | null;
  } | null;
  /** GS1-128 element string, or null where the variant carries no GTIN. */
  gs1: string | null;
  /** PNG data URI encoding `gs1 ?? code`, ready to render. */
  qrDataUri: string;
  printedAt: string;
  organizationName: string;
}
