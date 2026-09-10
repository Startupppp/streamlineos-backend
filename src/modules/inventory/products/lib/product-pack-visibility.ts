import {
  PRODUCT_TAX_FIELD_KEYS,
  PRODUCT_PHARMACY_FIELD_KEYS,
  PRODUCT_KIRANA_FIELD_KEYS,
  PRODUCT_MATERIALS_FIELD_KEYS,
} from "../dto/inv-products.schemas";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";

export interface PackVisibilityDeps {
  readonly settings: InventorySettingsService;
}

const TAX_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_TAX_FIELD_KEYS);
const PHARMACY_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_PHARMACY_FIELD_KEYS);
const KIRANA_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_KIRANA_FIELD_KEYS);
const MATERIALS_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_MATERIALS_FIELD_KEYS);

/**
 * E1/E2/E3/E4. Removes a pack's fields from a payload, at any nesting depth.
 *
 * Stripped from the response rather than hidden in the UI, for the same reason
 * cost fields are: a distributor that does not run the `gst` pack must not
 * receive an `hsnCode: null` it then has to explain, a warehouse must not
 * receive a `drugSchedule`, and a client that never sees a field cannot start
 * depending on it. Same shape as `stripCostFields` deliberately — one idea, now
 * four gates.
 */
function stripKeys(value: unknown, hidden: ReadonlySet<string>, depth: number): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, hidden, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (hidden.has(key)) continue;
    out[key] = stripKeys(inner, hidden, depth + 1);
  }
  return out;
}

/**
 * Which packs are on, in the one shape the list cache key and every stripper
 * read. Carried together so a caller cannot strip for one pack and key for
 * another — that mismatch is invisible until a cached payload is served to the
 * wrong organisation's screen.
 */
export interface ProductPackVisibility {
  gst: boolean;
  pharmacy: boolean;
  kirana: boolean;
  materials: boolean;
}

export function stripProductPackFields<T>(payload: T, visible: ProductPackVisibility): T {
  let out = payload;
  if (!visible.gst) out = stripKeys(out, TAX_FIELD_SET, 0) as T;
  if (!visible.pharmacy) out = stripKeys(out, PHARMACY_FIELD_SET, 0) as T;
  if (!visible.kirana) out = stripKeys(out, KIRANA_FIELD_SET, 0) as T;
  if (!visible.materials) out = stripKeys(out, MATERIALS_FIELD_SET, 0) as T;
  return out;
}

export async function packVisibility(
  deps: PackVisibilityDeps,
  orgId: string,
): Promise<ProductPackVisibility> {
  const settings = await deps.settings.get(orgId);
  return {
    gst: settings.packs.gst,
    pharmacy: settings.packs.pharmacy,
    kirana: settings.packs.kirana,
    materials: settings.packs.materials,
  };
}
