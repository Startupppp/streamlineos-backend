import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { invChannelPools, invChannels } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { availableQtySumSql, channelReservedQtySql } from "./available-sql";
import { addDec, cmpDec, netAvailableQty, subDec } from "./decimal";
import { runIdempotent, revivedScalar } from "./idempotency";
import { INV_ERRORS } from "./stock-engine.types";
import { InventoryAuditService } from "./inventory-audit.service";
import { WarehouseScopeService } from "./warehouse-scope.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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

export interface PoolAllocationInput {
  channelId: number;
  productVariantId: number;
  warehouseId?: number | null;
  /** A signed delta. Positive claims stock, negative gives it back. */
  deltaQty: string;
  idempotencyKey: string;
}

export interface ChannelPoolRow {
  id: number;
  channelId: number;
  channelName: string;
  warehouseId: number | null;
  productVariantId: number;
  reservedQty: string;
  publishedQty: string;
  updatedAt: Date;
}

/**
 * NEO-1 — who may be promised which units.
 *
 * The engine says how many units exist and where. This says how many of them a
 * given channel is still allowed to sell, which is a different question and the
 * one a brand selling on Blinkit and on its own storefront gets wrong. It writes
 * `inv_channel_pools` and nothing else: no ledger row, no `inv_stock_levels`
 * column, no second stock engine. Fulfilment still posts through
 * `StockEngineService`.
 *
 * It lives in `stock-engine/` rather than in `channels/` because availability is
 * engine territory — the reservation path has to consult it on every promise,
 * and a service in `channels/` would make that a cycle (`channels` already
 * imports the engine). The HTTP surface is in `channels/pools/`.
 */
@Injectable()
export class ChannelPoolService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * The one place the grain rule is applied.
   *
   * `forChannelId` splits the answer in two: everything held by *other* channels
   * reduces what may be promised, and what this channel holds is reported beside
   * it so a caller can tell "someone else has it" from "you already have it".
   * Without a channel, every pool counts as somebody else's — which is exactly
   * right for a direct sale.
   */
  async availability(
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

  /** The same question from a request, outside any transaction the caller owns. */
  /**
   * The person-facing entry point, scoped the way `listForChannel` below is.
   *
   * A named warehouse is asserted visible — the same rule, in the same words, as
   * the allocation path at the `assertWarehouseVisible` call further down. An
   * omitted one now narrows to the caller's own warehouses instead of summing
   * the estate.
   *
   * `availability` itself stays unscoped by default because `assertPromisable`
   * calls it to decide whether the ORGANISATION can promise these units, which
   * is a different question from whether the requester may see them.
   */
  async availabilityFor(
    orgId: string,
    userId: string,
    params: { productVariantId: number; warehouseId?: number | null; forChannelId?: number | null },
  ): Promise<ChannelAvailability> {
    if (params.warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, params.warehouseId);
      return this.availability(this.db, orgId, params);
    }
    const scope = await this.warehouseScope.resolve(orgId, userId);
    return this.availability(this.db, orgId, { ...params, scope });
  }

  /**
   * The gate every promise passes through.
   *
   * Called by `ReservationService` on the one path that actually promises stock
   * to somebody, so a direct sale cannot take units a marketplace is holding and
   * a marketplace order can take its own. A refusal is `INSUFFICIENT_STOCK`
   * because that is what it is from the caller's side — the stock exists, it is
   * spoken for — with the pool named in the message so the answer is actionable.
   */
  async assertPromisable(
    tx: Tx,
    orgId: string,
    params: {
      productVariantId: number;
      warehouseId: number | null;
      qty: string;
      forChannelId?: number | null;
    },
  ): Promise<void> {
    const claimed = await this.hasAnyPool(tx, orgId, params.productVariantId);
    // The overwhelmingly common case is a variant no channel has claimed, and
    // that must not cost two aggregates on every reservation in the product.
    if (!claimed) return;

    const state = await this.availability(tx, orgId, {
      productVariantId: params.productVariantId,
      warehouseId: params.warehouseId,
      forChannelId: params.forChannelId ?? null,
    });

    if (cmpDec(state.netAvailable, params.qty) < 0) {
      throw new BadRequestException({
        code: INV_ERRORS.INSUFFICIENT_STOCK,
        message:
          `${state.available} available, ${state.reservedByOthers} reserved to other sales channels — ` +
          `${state.netAvailable} may be promised here`,
      });
    }
  }

  private async hasAnyPool(executor: Tx | Db, orgId: string, productVariantId: number): Promise<boolean> {
    const [row] = await executor.execute<{ present: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM inv_channel_pools cp
        WHERE cp.org_id = ${orgId} AND cp.product_variant_id = ${productVariantId}
          AND cp.reserved_qty > 0
      ) AS present
    `);
    return row?.present === true;
  }

  /**
   * Move units into or out of a channel's claim.
   *
   * A signed delta rather than an absolute figure, and idempotent on the key:
   * two deliveries of "reserve 6" from a retried webhook must leave 6 reserved,
   * not 12, and `runIdempotent` is how every other command in this module says
   * that. The physical check is done against everything *else* claimed plus this
   * channel's own existing claim, so a channel cannot walk its pool past the
   * stock behind it one increment at a time.
   */
  async allocate(orgId: string, userId: string, input: PoolAllocationInput): Promise<ChannelPoolRow> {
    const row = await this.db.transaction(async (tx) =>
      runIdempotent(
        tx,
        orgId,
        input.idempotencyKey,
        { op: "channel-pool-allocate", ...input },
        () => this.allocateInTx(tx, orgId, userId, input),
        revivePoolRow,
      ),
    );
    return row;
  }

  async allocateInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    input: PoolAllocationInput,
  ): Promise<ChannelPoolRow> {
    const warehouseId = input.warehouseId ?? null;

    const [channel] = await tx
      .select({ id: invChannels.id, name: invChannels.name, status: invChannels.status })
      .from(invChannels)
      .where(and(eq(invChannels.orgId, orgId), eq(invChannels.id, input.channelId)));
    if (!channel) throw new NotFoundException("Not found");

    // An org-wide pool names no warehouse, so there is nothing to scope; a pinned
    // one is scoped like any other warehouse-bearing document.
    if (warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, warehouseId);
    }

    // Lock the grain before reading availability, or two concurrent allocations
    // both see the same free units and both take them.
    const [existing] = await tx.execute<{ id: number; reserved_qty: string; published_qty: string }>(sql`
      SELECT id, reserved_qty, published_qty
      FROM inv_channel_pools
      WHERE org_id = ${orgId} AND channel_id = ${input.channelId}
        AND product_variant_id = ${input.productVariantId}
        AND coalesce(warehouse_id, 0) = coalesce(${warehouseId}::integer, 0)
      FOR UPDATE
    `);

    const current = existing ? String(existing.reserved_qty) : "0";
    const next = addDec(current, input.deltaQty);

    if (cmpDec(next, "0") < 0) {
      throw new BadRequestException({
        code: INV_ERRORS.RELEASE_EXCEEDS_HELD,
        message: `This channel holds ${current}; cannot release ${subDec("0", input.deltaQty)}`,
      });
    }

    if (cmpDec(input.deltaQty, "0") > 0) {
      const state = await this.availability(tx, orgId, {
        productVariantId: input.productVariantId,
        warehouseId,
        forChannelId: input.channelId,
      });
      if (cmpDec(state.netAvailable, next) < 0) {
        throw new BadRequestException({
          code: INV_ERRORS.INSUFFICIENT_STOCK,
          message:
            `${state.netAvailable} may be claimed here (${state.available} available, ` +
            `${state.reservedByOthers} held by other channels); this pool would hold ${next}`,
        });
      }
    }

    // Raw SQL because the uniqueness is on `coalesce(warehouse_id, 0)`, an
    // expression index Drizzle's `onConflictDoUpdate` target cannot name — and a
    // conflict target that does not match the index silently becomes a plain
    // insert that fails on the second call instead of updating.
    const [saved] = await tx.execute<{
      id: number; channel_id: number; warehouse_id: number | null;
      product_variant_id: number; reserved_qty: string; published_qty: string; updated_at: Date;
    }>(sql`
      INSERT INTO inv_channel_pools (org_id, channel_id, warehouse_id, product_variant_id, reserved_qty)
      VALUES (${orgId}, ${input.channelId}, ${warehouseId}, ${input.productVariantId}, ${next}::numeric)
      ON CONFLICT (org_id, channel_id, product_variant_id, coalesce(warehouse_id, 0))
      DO UPDATE SET reserved_qty = ${next}::numeric, updated_at = now()
      RETURNING id, channel_id, warehouse_id, product_variant_id, reserved_qty, published_qty, updated_at
    `);

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: cmpDec(input.deltaQty, "0") >= 0 ? "channel_pool.allocate" : "channel_pool.release",
      resourceType: "inv_channel_pool",
      resourceId: String(saved!.id),
      before: { reservedQty: current },
      after: { reservedQty: next },
      metadata: {
        channelId: input.channelId,
        warehouseId,
        productVariantId: input.productVariantId,
        deltaQty: input.deltaQty,
      },
    });

    return {
      id: Number(saved!.id),
      channelId: Number(saved!.channel_id),
      channelName: channel.name,
      warehouseId: saved!.warehouse_id === null ? null : Number(saved!.warehouse_id),
      productVariantId: Number(saved!.product_variant_id),
      reservedQty: String(saved!.reserved_qty),
      publishedQty: String(saved!.published_qty),
      updatedAt: new Date(saved!.updated_at),
    };
  }

  /**
   * Draw a channel's claim down as its order actually ships.
   *
   * Called inside the fulfilment transaction, after the engine has issued the
   * units: the claim existed to stop anyone else selling them, and once they are
   * gone there is nothing left to hold. Clamped rather than checked — a pool that
   * has already been drawn to zero by a partial ship is not an error to report to
   * a picker, and the ledger, not this table, is the record of what left.
   */
  async consumeInTx(
    tx: Tx,
    orgId: string,
    params: { channelId: number; productVariantId: number; warehouseId?: number | null; qty: string },
  ): Promise<void> {
    const warehouseId = params.warehouseId ?? null;
    await tx.execute(sql`
      UPDATE inv_channel_pools
      SET reserved_qty = GREATEST(0, reserved_qty - ${params.qty}::numeric), updated_at = now()
      WHERE org_id = ${orgId} AND channel_id = ${params.channelId}
        AND product_variant_id = ${params.productVariantId}
        AND (warehouse_id IS NULL OR warehouse_id = ${warehouseId})
    `);
  }

  /**
   * What the channel was last told. A snapshot never writes `reserved_qty` — E6's
   * rule, unchanged: a marketplace's figure is a signal, not a ledger entry.
   */
  async recordPublishedInTx(
    tx: Tx,
    orgId: string,
    rows: Array<{ channelId: number; productVariantId: number; warehouseId?: number | null; publishedQty: string }>,
  ): Promise<void> {
    for (const row of rows) {
      await tx.execute(sql`
        INSERT INTO inv_channel_pools (org_id, channel_id, warehouse_id, product_variant_id, published_qty)
        VALUES (${orgId}, ${row.channelId}, ${row.warehouseId ?? null}, ${row.productVariantId}, ${row.publishedQty}::numeric)
        ON CONFLICT (org_id, channel_id, product_variant_id, coalesce(warehouse_id, 0))
        DO UPDATE SET published_qty = ${row.publishedQty}::numeric, updated_at = now()
      `);
    }
  }

  /** Every pool a channel holds, for the channel settings screen. */
  async listForChannel(orgId: string, userId: string, channelId: number): Promise<ChannelPoolRow[]> {
    const [channel] = await this.db
      .select({ id: invChannels.id, name: invChannels.name })
      .from(invChannels)
      .where(and(eq(invChannels.orgId, orgId), eq(invChannels.id, channelId)));
    if (!channel) throw new NotFoundException("Not found");

    const scope = await this.warehouseScope.resolve(orgId, userId);
    const rows = await this.db
      .select({
        id: invChannelPools.id,
        channelId: invChannelPools.channelId,
        warehouseId: invChannelPools.warehouseId,
        productVariantId: invChannelPools.productVariantId,
        reservedQty: invChannelPools.reservedQty,
        publishedQty: invChannelPools.publishedQty,
        updatedAt: invChannelPools.updatedAt,
      })
      .from(invChannelPools)
      .where(and(eq(invChannelPools.orgId, orgId), eq(invChannelPools.channelId, channelId)));

    return rows
      .filter((r) => scope === null || r.warehouseId === null || scope.includes(r.warehouseId))
      .map((r) => ({ ...r, channelName: channel.name }));
  }

  /**
   * Every channel's claim on one variant, for the stock row popover.
   *
   * The stock screen shows on-hand and ATP; without this it cannot say *why* the
   * two differ by six units, which is the question a warehouse manager actually
   * asks when a marketplace order they can see refuses to fill.
   */
  /**
   * Scoped exactly as `listForChannel` is, including its treatment of a pool
   * that names NO warehouse: an org-wide pool has nothing to scope by and stays
   * visible to everyone. That rule is this module's, taken from its own sibling
   * rather than from a house default — elsewhere in inventory an unattributed
   * row is excluded.
   */
  async listForVariant(
    orgId: string,
    userId: string,
    productVariantId: number,
    warehouseId?: number | null,
  ): Promise<ChannelPoolRow[]> {
    const rows = await this.db
      .select({
        id: invChannelPools.id,
        channelId: invChannelPools.channelId,
        channelName: invChannels.name,
        warehouseId: invChannelPools.warehouseId,
        productVariantId: invChannelPools.productVariantId,
        reservedQty: invChannelPools.reservedQty,
        publishedQty: invChannelPools.publishedQty,
        updatedAt: invChannelPools.updatedAt,
      })
      .from(invChannelPools)
      .innerJoin(invChannels, and(eq(invChannels.orgId, invChannelPools.orgId), eq(invChannels.id, invChannelPools.channelId)))
      .where(and(eq(invChannelPools.orgId, orgId), eq(invChannelPools.productVariantId, productVariantId)));

    const scope = await this.warehouseScope.resolve(orgId, userId);
    const inScope = rows.filter(
      (r) => scope === null || r.warehouseId === null || scope.includes(r.warehouseId),
    );

    return warehouseId == null
      ? inScope
      : inScope.filter((r) => r.warehouseId === null || r.warehouseId === warehouseId);
  }

  /** Bulk read for a stock list: variant → total reserved across all channels. */
  async reservedByVariant(
    executor: Tx | Db,
    orgId: string,
    productVariantIds: number[],
    warehouseId?: number | null,
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (productVariantIds.length === 0) return out;

    const rows = await executor
      .select({
        productVariantId: invChannelPools.productVariantId,
        warehouseId: invChannelPools.warehouseId,
        reservedQty: invChannelPools.reservedQty,
      })
      .from(invChannelPools)
      .where(and(eq(invChannelPools.orgId, orgId), inArray(invChannelPools.productVariantId, productVariantIds)));

    for (const row of rows) {
      if (warehouseId != null && row.warehouseId !== null && row.warehouseId !== warehouseId) continue;
      out.set(row.productVariantId, addDec(out.get(row.productVariantId) ?? "0", row.reservedQty));
    }
    return out;
  }
}

/** `runIdempotent` stores JSON, so a replayed row comes back with string dates. */
export function revivePoolRow(stored: unknown): ChannelPoolRow {
  const value = revivedScalar(stored) as Record<string, unknown>;
  return { ...(value as unknown as ChannelPoolRow), updatedAt: new Date(String(value.updatedAt)) };
}
