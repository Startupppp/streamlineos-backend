import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { cmpDec } from "../stock-engine/decimal";
import type { ConvertOwnershipInput } from "./dto/stock-types.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface OwnershipConversionResult {
  productVariantId: number;
  locationId: number;
  quantity: string;
  fromOwnership: string;
  toOwnership: string;
  transactionIds: number[];
}

/**
 * NEO-11 - taking title to consigned stock.
 *
 * Consignment is "it is in our building and it is the supplier's until it
 * sells". `availableQty` returns zero for it and valuation excludes it, both in
 * the canonical files, so until this command runs a consigned pallet is
 * invisible to every promise and every balance sheet.
 *
 * **Taking title is explicit and is its own act.** It is not a side effect of
 * shipping, and it is not automatic: the moment ownership transfers is the moment
 * a liability to the supplier is created, and a system that decided that on
 * somebody's behalf would be inventing an accounting event. The sale then happens
 * from owned stock like any other sale, posting COGS the ordinary way.
 *
 * Mechanically it is two engine movements at one grain: out of the consigned
 * row, into the owned one. `unitCost` is the price agreed with the supplier and
 * is required - consigned stock has no cost of ours until this moment, so there
 * is nothing to inherit and nothing to estimate.
 */
@Injectable()
export class OwnershipService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: StockEngineService,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async convert(
    orgId: string,
    userId: string,
    input: ConvertOwnershipInput,
    idempotencyKey: string,
  ): Promise<OwnershipConversionResult> {
    if (input.fromOwnership === input.toOwnership) {
      throw new BadRequestException("The stock already has that owner");
    }
    await this.warehouseScope.assertLocationVisible(orgId, userId, input.locationId);

    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.ownership.convert", ...input },
        () => this.convertInTx(tx, orgId, userId, input, idempotencyKey),
        (stored) => stored as OwnershipConversionResult,
      ),
    );
  }

  private async convertInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    input: ConvertOwnershipInput,
    idempotencyKey: string,
  ): Promise<OwnershipConversionResult> {
    const [level] = await tx.execute<{ on_hand: string }>(sql`
      SELECT on_hand FROM inv_stock_levels
      WHERE org_id = ${orgId}
        AND product_variant_id = ${input.productVariantId}
        AND location_id = ${input.locationId}
        AND (lot_id IS NOT DISTINCT FROM ${input.lotId ?? null})
        AND ownership = ${input.fromOwnership}
      FOR UPDATE
    `);

    const onHand = level?.on_hand ?? "0";
    if (cmpDec(onHand, input.quantity) < 0) {
      throw new BadRequestException(
        `Only ${onHand} is held here as ${input.fromOwnership.toLowerCase()} stock`,
      );
    }

    const result = await this.engine.executeInTx(tx, orgId, userId, {
      idempotencyKey: `${idempotencyKey}:stock`,
      sourceType: "inv_ownership_conversion",
      sourceId: `${input.productVariantId}:${input.locationId}`,
      reason: `Ownership ${input.fromOwnership} → ${input.toOwnership}`,
      movements: [
        {
          transactionType: "TRANSFER_OUT",
          productVariantId: input.productVariantId,
          locationId: input.locationId,
          lotId: input.lotId ?? undefined,
          ownership: input.fromOwnership,
          quantityDelta: `-${input.quantity}`,
          // The consigned row carries no cost of ours, so there is nothing for
          // this issue to draw from and nothing for it to settle.
          settledCost: { unitCost: null, totalCost: null },
        },
        {
          transactionType: "TRANSFER_IN",
          productVariantId: input.productVariantId,
          locationId: input.locationId,
          lotId: input.lotId ?? undefined,
          ownership: input.toOwnership,
          quantityDelta: input.quantity,
          unitCost: input.unitCost,
        },
      ],
    });

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "stock.ownership.convert",
      resourceType: "inv_product_variant",
      resourceId: String(input.productVariantId),
      before: { ownership: input.fromOwnership },
      after: { ownership: input.toOwnership, quantity: input.quantity, unitCost: input.unitCost },
      metadata: { locationId: input.locationId, lotId: input.lotId ?? null },
    });

    return {
      productVariantId: input.productVariantId,
      locationId: input.locationId,
      quantity: input.quantity,
      fromOwnership: input.fromOwnership,
      toOwnership: input.toOwnership,
      transactionIds: result.transactionIds,
    };
  }

  /** What is standing here that is not ours, for the stock screen to say so. */
  async listConsigned(orgId: string, userId: string, warehouseId?: number | null) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    if (scope.isEmpty) return [];

    return this.db.execute<{
      product_variant_id: number; location_id: number; ownership: string; on_hand: string;
    }>(sql`
      SELECT sl.product_variant_id, sl.location_id, sl.ownership, sl.on_hand::text AS on_hand
      FROM inv_stock_levels sl
      JOIN inv_locations loc ON loc.id = sl.location_id AND loc.org_id = sl.org_id
      WHERE sl.org_id = ${orgId}
        AND sl.ownership <> 'OWNED'
        AND sl.on_hand <> 0
        ${warehouseId != null ? sql`AND loc.warehouse_id = ${warehouseId}` : sql``}
        AND ${scope.location(sql`sl.location_id`)}
      ORDER BY sl.product_variant_id, sl.location_id
      LIMIT 500
    `);
  }
}
