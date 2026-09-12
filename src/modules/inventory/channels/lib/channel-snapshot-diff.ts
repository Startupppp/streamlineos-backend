import { and, eq, inArray, sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { invChannelSnapshotDiffs, invLocations } from "../../../../db/schema";
import { availableQtySumSql } from "../../stock-engine/available-sql";
import type { ChannelSnapshotResult } from "../channel-adapter";
import { planSnapshotDifferences } from "../snapshot-difference";
import type { ChannelContext, DrainableDelivery } from "./channel-snapshot-context";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Turn a snapshot into differences, and nothing else.
 *
 * Only SKUs the channel actually mentioned produce a row. A SKU it did not
 * mention has told us nothing — and the difference between "told us nothing"
 * and "told us zero" is the difference between a reconciliation report and a
 * warehouse being emptied by a bad response body.
 */
export async function recordDifferences(
  tx: Tx,
  delivery: DrainableDelivery | null,
  context: ChannelContext,
  snapshot: Extract<ChannelSnapshotResult, { ok: true }>,
): Promise<number> {
  if (snapshot.items.length === 0) return 0;

  const variantIds = snapshot.items
    .map((item) => context.skuToVariant.get(item.sku))
    .filter((id): id is number => typeof id === "number");

  const internalAvailability = await readInternalAvailability(tx, context, variantIds);

  // The rule lives in `planSnapshotDifferences`, not here: only SKUs the
  // channel actually mentioned produce a row, and a matched SKU that agrees
  // produces none. Keeping it pure is what lets a unit test prove that a 200
  // carrying an error body cannot manufacture "the channel says 0" for every
  // SKU we publish.
  const planned = planSnapshotDifferences({
    snapshot,
    skuToVariant: context.skuToVariant,
    internalAvailability,
  });

  for (const difference of planned) {
    await tx
      .insert(invChannelSnapshotDiffs)
      .values({
        orgId: context.orgId,
        channelId: context.channelId,
        deliveryId: delivery?.id ?? null,
        productVariantId: difference.productVariantId,
        externalSku: difference.externalSku,
        channelQty: difference.channelQty,
        internalQty: difference.internalQty,
        difference: difference.difference,
        status: "OPEN",
        snapshotAt: snapshot.capturedAt,
      })
      .onConflictDoUpdate({
        // The partial unique index on OPEN rows. A later refetch finding the
        // same disagreement updates it rather than adding to a pile, so an
        // operator sees one row per SKU rather than one per delivery.
        target: [
          invChannelSnapshotDiffs.orgId,
          invChannelSnapshotDiffs.channelId,
          invChannelSnapshotDiffs.externalSku,
        ],
        targetWhere: sql`status = 'OPEN'`,
        set: {
          deliveryId: delivery?.id ?? null,
          productVariantId: difference.productVariantId,
          channelQty: difference.channelQty,
          internalQty: difference.internalQty,
          difference: difference.difference,
          snapshotAt: snapshot.capturedAt,
          updatedAt: new Date(),
        },
      });
  }

  return planned.length;
}

/**
 * What we believe is sellable on this channel, by variant.
 *
 * The same expression the publisher uses — `availableQtySumSql` — and
 * deliberately not a private copy. A reconciliation that compared the channel
 * against a *different* definition of availability than the one we published
 * would report a difference on every SKU and be right about none of them.
 */
async function readInternalAvailability(
  tx: Tx,
  context: ChannelContext,
  variantIds: readonly number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (variantIds.length === 0 || context.warehouseIds.length === 0) return out;

  const locations = await tx
    .select({ id: invLocations.id })
    .from(invLocations)
    .where(
      and(
        eq(invLocations.orgId, context.orgId),
        inArray(invLocations.warehouseId, [...context.warehouseIds]),
      ),
    );
  if (locations.length === 0) return out;

  const rows = await tx.execute<{ product_variant_id: number; available: string }>(sql`
    SELECT inv_stock_levels.product_variant_id,
           ${availableQtySumSql("inv_stock_levels")}::text AS available
      FROM inv_stock_levels
     WHERE inv_stock_levels.org_id = ${context.orgId}
       AND inv_stock_levels.location_id IN (${sql.join(
         locations.map((l) => sql`${l.id}`),
         sql`, `,
       )})
       AND inv_stock_levels.product_variant_id IN (${sql.join(
         variantIds.map((id) => sql`${id}`),
         sql`, `,
       )})
     GROUP BY inv_stock_levels.product_variant_id
  `);

  for (const row of rows) out.set(Number(row.product_variant_id), String(row.available));
  return out;
}
