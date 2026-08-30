import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import type { SuggestPutawayInput } from "./dto/inv-warehouses.schemas";
import { cmpDec, subDec } from "../stock-engine/decimal";
import { SlottingService } from "../slotting/slotting.service";
import { rankBySlot, type SlottedSuggestion } from "../slotting/slotting-rules";

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
    private readonly slotting: SlottingService,
  ) {}

  /**
   * INV-202 — where should this go?
   *
   * Ranking, in order, and each rank is a real operational preference rather
   * than a tidy sort:
   *
   *   1. Locations where the quantity actually fits, because a suggestion that
   *      cannot be accepted is worse than no suggestion — the engine will
   *      refuse the putaway and the operator has walked for nothing.
   *   2. **NEO-6.** Bins inside the zone the slotting rules point at for this
   *      SKU. Above consolidation deliberately: putting a fast mover beside its
   *      own existing stock in a back aisle is exactly the outcome slotting
   *      exists to stop.
   *   3. Among the rest, locations already holding this variant, so a SKU does
   *      not scatter across a building one delivery at a time. Consolidation is
   *      what makes a later pick one walk instead of three.
   *   4. Most remaining room first, so the building fills evenly rather than
   *      wedging every delivery into the first bin with a gap.
   *
   * Unlimited locations sort as unlimited rather than as "very large", so a bin
   * with no capacity recorded does not silently outrank every measured one.
   *
   * An organisation that has written no rules matches nothing, so rank 2 is a
   * constant and the order is precisely the INV-202 one it had before — which is
   * why NEO-6 is a re-rank rather than a replacement. The ordering itself lives
   * in `slotting/slotting-rules.ts` as a pure function, because it is the part
   * with an opinion and the part worth testing on its own.
   */
  async suggest(
    orgId: string,
    userId: string,
    input: SuggestPutawayInput,
  ): Promise<SlottedSuggestion[]> {
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
      // Exact, like every other quantity comparison in this module. These are
      // numeric(18,4) values and the rest of the phase went to some trouble to
      // stop them becoming floats on the way to a decision.
      const remaining =
        row.capacity === null ? null : subDec(row.capacity, row.on_hand);
      return {
        locationId: row.id,
        code: row.code,
        name: row.name,
        capacity: row.capacity,
        onHand: row.on_hand,
        remaining,
        holdsVariant: row.holds_variant,
        fits: remaining === null || cmpDec(remaining, input.quantity) >= 0,
      } satisfies PutawaySuggestion;
    });

    // Order matters and the comment above is the contract: a bin that does not
    // fit is useless whatever else is true of it, so `fits` sorts first; then the
    // slot; then consolidation. The earlier version documented consolidation as
    // the first key and implemented it as the second, which is the kind of
    // disagreement that survives review because both halves read reasonably on
    // their own — so the ordering is now one pure function with its own spec.
    const slot = await this.slotting.slotFor(this.db, orgId, {
      warehouseId: input.warehouseId,
      productVariantId: input.productVariantId,
    });
    return rankBySlot(suggestions, slot);
  }
}
