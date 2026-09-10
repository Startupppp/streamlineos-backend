import { and, eq, inArray } from "drizzle-orm";
import { invStockLevels } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { availableQty } from "../../stock-engine/decimal";

/**
 * Available-to-promise across a set of variants, lifted out of
 * `so-core.service.ts` unchanged. It used the db handle and nothing else.
 *
 * Still public API on the service through a delegate — a caller reaches it that
 * way — but the 106 lines of query no longer have to live in the CRUD file.
 */
export async function getAtp(db: Db, orgId: string, productVariantIds: number[]) {
    if (productVariantIds.length === 0) return [];

    const levels = await db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        inArray(invStockLevels.productVariantId, productVariantIds),
      ),
      columns: {
        productVariantId: true,
        onHand: true,
        committed: true,
        onOrder: true,
        blockedQty: true,
        qualityHoldQty: true,
        outgoingQty: true,
      },
      // A2. Availability now depends on where the row stands, not only on its
      // buckets: goods parked at a warehouse's TRANSIT location are on hand and
      // are not for sale. Without this the ATP a sales order quotes would
      // include stock that is physically in a van.
      with: { location: { columns: { isSellable: true } } },
    });

    const grouped = new Map<
      number,
      {
        onHand: number;
        committed: number;
        onOrder: number;
        blocked: number;
        qualityHold: number;
        outgoing: number;
        available: number;
      }
    >();

    for (const l of levels) {
      const existing = grouped.get(l.productVariantId);
      const onHand = parseFloat(l.onHand);
      const committed = parseFloat(l.committed);
      const onOrder = parseFloat(l.onOrder);
      const blocked = parseFloat(l.blockedQty ?? "0");
      const qualityHold = parseFloat(l.qualityHoldQty ?? "0");
      const outgoing = parseFloat(l.outgoingQty ?? "0");
      // A2. Per row, before anything is summed. The subtraction is linear so
      // the total is the same one summing-then-subtracting produced -- except
      // that the location gate can only be applied while the row still knows
      // which location it belongs to.
      const available = Number(
        availableQty({
          on_hand: l.onHand,
          committed: l.committed,
          blocked_qty: l.blockedQty,
          quality_hold_qty: l.qualityHoldQty,
          outgoing_qty: l.outgoingQty,
          is_sellable: l.location?.isSellable ?? null,
        }),
      );

      if (existing) {
        existing.onHand += onHand;
        existing.committed += committed;
        existing.onOrder += onOrder;
        existing.blocked += blocked;
        existing.qualityHold += qualityHold;
        existing.outgoing += outgoing;
        existing.available += available;
      } else {
        grouped.set(l.productVariantId, {
          onHand,
          committed,
          onOrder,
          blocked,
          qualityHold,
          outgoing,
          available,
        });
      }
    }

    return productVariantIds.map((id) => {
      const agg = grouped.get(id);
      const onHand = agg?.onHand ?? 0;
      const committed = agg?.committed ?? 0;
      const blocked = agg?.blocked ?? 0;
      const qualityHold = agg?.qualityHold ?? 0;
      const onOrder = agg?.onOrder ?? 0;
      const outgoing = agg?.outgoing ?? 0;
      return {
        productVariantId: id,
        onHand,
        committed,
        blocked,
        qualityHold,
        onOrder,
        // A1/A2. One formula, applied per stock row above. This copy omitted
        // outgoing_qty, so a line already picked and waiting on the bench was
        // offered to the next order — and `outgoingQty` was reported as
        // `committed`, which is a different bucket entirely.
        available: agg?.available ?? 0,
        incomingQty: onOrder,
        outgoingQty: outgoing,
      };
    });
  }
