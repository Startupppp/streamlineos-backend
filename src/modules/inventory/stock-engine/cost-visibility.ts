import { Injectable } from "@nestjs/common";
import { AccessService } from "../../access/access.service";

/** Holding this key means "may see what stock is worth". */
export const COST_VISIBILITY_PERMISSION = "inventory:valuation:read";

/**
 * Every field that reveals what stock cost or what margin it carries. Stripped
 * from the response body rather than hidden in the UI: a warehouse operator's
 * payload must not contain unit cost at all, since supplier pricing is
 * commercially sensitive and frequently NDA-bound.
 */
const COST_FIELDS = [
  "averageCost", "average_cost",
  "unitCost", "unit_cost",
  "totalCost", "total_cost",
  "costPrice", "cost_price",
  "standardCost", "standard_cost",
  "landedCost", "landed_cost",
  "costAtTime", "cost_at_time",
  "totalValue", "total_value",
  "remainingValue", "remaining_value",
  "margin", "marginPct", "margin_pct",
] as const;

const COST_FIELD_SET: ReadonlySet<string> = new Set(COST_FIELDS);

function stripValue(value: unknown, depth: number): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  // A Date has no own keys: rebuilding it below would send `{}` for every timestamp.
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => stripValue(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (COST_FIELD_SET.has(key)) continue;
    out[key] = stripValue(inner, depth + 1);
  }
  return out;
}

/** Removes every cost-bearing field from a payload, at any nesting depth. */
export function stripCostFields<T>(payload: T): T {
  return stripValue(payload, 0) as T;
}

@Injectable()
export class CostVisibilityService {
  constructor(private readonly access: AccessService) {}

  async canSeeCost(orgId: string, userId: string): Promise<boolean> {
    const permissions = await this.access.resolveUserPermissions(orgId, userId);
    return permissions.has(COST_VISIBILITY_PERMISSION);
  }

  /** Returns the payload unchanged for cost-permitted callers, stripped otherwise. */
  async apply<T>(orgId: string, userId: string, payload: T): Promise<T> {
    if (await this.canSeeCost(orgId, userId)) return payload;
    return stripCostFields(payload);
  }
}
