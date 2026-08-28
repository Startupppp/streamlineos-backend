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
