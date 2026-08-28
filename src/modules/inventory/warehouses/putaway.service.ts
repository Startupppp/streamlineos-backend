import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import type { SuggestPutawayInput } from "./dto/inv-warehouses.schemas";

export interface PutawaySuggestion {
  locationId: number;
  code: string;
  name: string;
  /** null when the location records no capacity, which means unlimited. */
  capacity: string | null;
  onHand: string;
  remaining: string | null;
  /** Whether this location already holds the variant being put away. */
  holdsVariant: boolean;
  fits: boolean;
}

@Injectable()
export class PutawayService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * INV-202 — where should this go?
   *
   * Ranking, in order, and each rank is a real operational preference rather
   * than a tidy sort:
   *
   *   1. Locations already holding this variant, so a SKU does not scatter
   *      across a building one delivery at a time. Consolidation is what makes
   *      a later pick one walk instead of three.
   *   2. Locations where the quantity actually fits, because a suggestion that
   *      cannot be accepted is worse than no suggestion — the engine will
   *      refuse the putaway and the operator has walked for nothing.
   *   3. Most remaining room first, so the building fills evenly rather than
   *      wedging every delivery into the first bin with a gap.
   *
   * Unlimited locations sort as unlimited rather than as "very large", so a bin
   * with no capacity recorded does not silently outrank every measured one.
   */
  async suggest(
    orgId: string,
    userId: string,
    input: SuggestPutawayInput,
  ): Promise<PutawaySuggestion[]> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.isEmpty) return [];

    const rows = await this.db.execute<{
      id: number;
      code: string;
      name: string;
      capacity: string | null;
      on_hand: string;
      holds_variant: boolean;
    }>(sql`
      SELECT
        l.id,
        l.code,
        l.name,
        l.capacity::text AS capacity,
        COALESCE(SUM(sl.on_hand), 0)::text AS on_hand,
        BOOL_OR(sl.product_variant_id = ${input.productVariantId}) IS TRUE AS holds_variant
      FROM inv_locations l
      LEFT JOIN inv_stock_levels sl
        ON sl.org_id = l.org_id AND sl.location_id = l.id
      WHERE l.org_id = ${orgId}
        AND l.warehouse_id = ${input.warehouseId}
        AND l.is_active = true
        AND l.is_receivable = true
        AND ${scope.location(sql`l.id`)}
      GROUP BY l.id, l.code, l.name, l.capacity
      ORDER BY l.code
      LIMIT 100
    `);

    const suggestions = rows.map((row) => {
      const remaining =
        row.capacity === null
          ? null
          : (Number(row.capacity) - Number(row.on_hand)).toFixed(4);
      return {
        locationId: row.id,
        code: row.code,
        name: row.name,
        capacity: row.capacity,
        onHand: row.on_hand,
        remaining,
        holdsVariant: row.holds_variant,
        fits: remaining === null || Number(remaining) >= Number(input.quantity),
      } satisfies PutawaySuggestion;
    });

    return suggestions.sort((a, b) => {
      if (a.fits !== b.fits) return a.fits ? -1 : 1;
      if (a.holdsVariant !== b.holdsVariant) return a.holdsVariant ? -1 : 1;
      if (a.remaining === null && b.remaining === null) return 0;
      if (a.remaining === null) return 1;
      if (b.remaining === null) return -1;
      return Number(b.remaining) - Number(a.remaining);
    });
  }
}
