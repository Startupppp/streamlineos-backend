import { z } from "zod";

export const barcodeLookupSchema = z.object({
  code: z.string().trim().min(1).max(200),
});
export type BarcodeLookupInput = z.infer<typeof barcodeLookupSchema>;

export type BarcodeLookupResult =
  | { type: "product"; productId: number; name: string; sku: string; status: string; totalOnHand: string }
  | { type: "variant"; variantId: number; productId: number; name: string; sku: string; isActive: boolean; totalOnHand: string }
  | { type: "lot"; lotId: number; variantId: number; lotNumber: string; status: string }
  | { type: "serial"; serialId: number; variantId: number; serialNumber: string; status: string; currentLocationId: number | null }
  | { type: "location"; locationId: number; warehouseId: number; name: string; code: string; locationType: string; isActive: boolean }
  | { type: "not_found" };
