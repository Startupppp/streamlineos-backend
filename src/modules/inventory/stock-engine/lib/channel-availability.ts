import { sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { availableQtySumSql, channelReservedQtySql } from "../available-sql";
import { netAvailableQty } from "../decimal";

/**
 * The read half of the channel pools: how much of a variant may still be
 * promised, and whether any channel has claimed it at all.
 *
 * Lifted out of `channel-pool.service.ts` unchanged. Both took their executor as
 * an argument already and reached for nothing on the service, so they are
 * functions rather than methods — which is also what lets the spec call them
 * without standing a service up.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ChannelAvailability {
  productVariantId: number;
  warehouseId: number | null;
  /** Physical, sellable, net of committed/blocked/hold/outgoing. `availableQty`. */
  available: string;
  /** What other channels are holding, per the grain rule in `channel-pools.ts`. */
  reservedByOthers: string;
  /** What this channel (or, org-wide, this pool row) already holds. */
  reservedForChannel: string;
  /** `netAvailableQty(available, reservedByOthers)` — what may still be promised. */
  netAvailable: string;
}

  /**
   * The one place the grain rule is applied.
   *
   * `forChannelId` splits the answer in two: everything held by *other* channels
   * reduces what may be promised, and what this channel holds is reported beside
   * it so a caller can tell "someone else has it" from "you already have it".
   * Without a channel, every pool counts as somebody else's — which is exactly
   * right for a direct sale.
   */
export async function availability(
    executor: Tx | Db,
    orgId: string,
    params: {
      productVariantId: number;
      warehouseId?: number | null;
      forChannelId?: number | null;
      /**
       * The caller's warehouses, when this is answering a person rather than the
       * promise path. `undefined` is unrestricted, which is what the internal
       * callers want: `assertPromisable` is deciding whether the ORGANISATION
       * can promise these units, not whether the requester may look at them.
       */
      scope?: number[] | null;
    },
  ): Promise<ChannelAvailability> {
    const warehouseId = params.warehouseId ?? null;
    const forChannelId = params.forChannelId ?? null;
    const scope = params.scope;

    /*
     * A NAMED warehouse filters to it. An OMITTED one used to mean `TRUE` — every
     * building in the organisation — and now means every building the caller
     * holds, when a caller was supplied. A default that widens is the half of
     * this that reads as correct: the explicit parameter looks like the whole
     * surface, and it is the missing one that opens the estate.
     */
    const warehouseGate =
      warehouseId != null
        ? sql`loc.warehouse_id = ${warehouseId}`
        : scope === undefined || scope === null
          ? sql`TRUE`
          : scope.length === 0
            ? sql`FALSE`
            : sql`loc.warehouse_id IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`;

    const [physical] = await executor.execute<{ available: string }>(sql`
      SELECT ${availableQtySumSql("sl")} AS available
      FROM inv_stock_levels sl
      JOIN inv_locations loc ON loc.id = sl.location_id AND loc.org_id = sl.org_id
      WHERE sl.org_id = ${orgId}
        AND sl.product_variant_id = ${params.productVariantId}
        AND ${warehouseGate}
    `);

    const [claims] = await executor.execute<{ others: string; mine: string }>(sql`
      SELECT
        ${channelReservedQtySql({
          orgId,
          productVariantId: params.productVariantId,
          warehouseId,
          excludeChannelId: forChannelId,
        })} AS others,
        ${
          forChannelId == null
            ? sql`0::numeric`
            : sql`(
                SELECT COALESCE(SUM(cp.reserved_qty), 0)::numeric
                FROM inv_channel_pools cp
                WHERE cp.org_id = ${orgId}
                  AND cp.product_variant_id = ${params.productVariantId}
                  AND cp.channel_id = ${forChannelId}
                  AND ${warehouseId == null ? sql`TRUE` : sql`(cp.warehouse_id IS NULL OR cp.warehouse_id = ${warehouseId})`}
              )`
        } AS mine
    `);

    const available = String(physical?.available ?? "0");
    const reservedByOthers = String(claims?.others ?? "0");
    const reservedForChannel = String(claims?.mine ?? "0");

    return {
      productVariantId: params.productVariantId,
      warehouseId,
      available,
      reservedByOthers,
      reservedForChannel,
      netAvailable: netAvailableQty(available, reservedByOthers),
    };
  }

export async function hasAnyPool(executor: Tx | Db, orgId: string, productVariantId: number): Promise<boolean> {
    const [row] = await executor.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM inv_channel_pools cp
        WHERE cp.org_id = ${orgId} AND cp.product_variant_id = ${productVariantId}
          AND cp.reserved_qty > 0
      ) AS present
    `);
    return row?.present === true;
  }
