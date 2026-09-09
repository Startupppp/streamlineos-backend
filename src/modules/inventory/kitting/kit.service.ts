import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { invKitComponents, invStockTransactions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { addDec, cmpDec, divDec } from "../stock-engine/decimal";
import { availableQtySumSql } from "../stock-engine/available-sql";
import {
  apportionKitCost,
  buildableKits,
  explode,
  shortComponents,
  type BomLine,
} from "./kit-math";
import type {
  AssembleKitInput,
  DisassembleKitInput,
  SetKitBomInput,
} from "./dto/kitting.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface KitAssemblyResult {
  kitVariantId: number;
  locationId: number;
  quantity: string;
  /** What the built kits cost, taken from what the components actually consumed. */
  totalCost: string;
  transactionIds: number[];
}

/**
 * NEO-9 - building and breaking kits.
 *
 * Assembly is one command with two halves: the components leave and the kit
 * arrives, at one location, in one transaction. Both halves go through
 * `StockEngineService`, because a kit is stock and there is one thing in this
 * system that writes stock.
 *
 * **The kit's cost is what the components actually consumed**, not an estimate
 * of it. The engine tells us what each issue drew from its layers, so the build
 * is costed after the components have been issued and before the kit is
 * received - two engine calls under one transaction and one derived key family,
 * for the same reason a transfer's transit leg is: estimating is exact under
 * weighted average and wrong under FIFO the moment an issue crosses a layer.
 */
@Injectable()
export class KitService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: StockEngineService,
    private readonly audit: InventoryAuditService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /* ---------------------------------------------------------------- *
   * The bill of materials
   * ---------------------------------------------------------------- */

  async getBom(orgId: string, kitVariantId: number) {
    return this.db
      .select({
        id: invKitComponents.id,
        componentVariantId: invKitComponents.componentVariantId,
        quantityPer: invKitComponents.quantityPer,
        lineOrder: invKitComponents.lineOrder,
      })
      .from(invKitComponents)
      .where(and(eq(invKitComponents.orgId, orgId), eq(invKitComponents.kitVariantId, kitVariantId)))
      .orderBy(asc(invKitComponents.lineOrder), asc(invKitComponents.id));
  }

  /**
   * Replace a kit's bill of materials wholesale.
   *
   * Wholesale rather than line by line, for the reason a recount is: "these are
   * the components" is what somebody editing a kit means, and a partial merge
   * would need a stable line identity they do not have in front of them.
   */
  async setBom(orgId: string, userId: string, kitVariantId: number, input: SetKitBomInput) {
    for (const line of input.components) {
      if (line.componentVariantId === kitVariantId) {
        throw new BadRequestException("A kit cannot contain itself");
      }
    }
    await this.assertNoCycle(orgId, kitVariantId, input.components.map((c) => c.componentVariantId));

    await this.db.transaction(async (tx) => {
      await tx
        .delete(invKitComponents)
        .where(
          and(eq(invKitComponents.orgId, orgId), eq(invKitComponents.kitVariantId, kitVariantId)),
        );

      if (input.components.length > 0) {
        await tx.insert(invKitComponents).values(
          input.components.map((line, index) => ({
            orgId,
            kitVariantId,
            componentVariantId: line.componentVariantId,
            quantityPer: line.quantityPer,
            lineOrder: index,
            createdBy: userId,
          })),
        );
      }

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "kit.bom.set",
        resourceType: "inv_product_variant",
        resourceId: String(kitVariantId),
        after: { components: input.components.length },
      });
    });

    return this.getBom(orgId, kitVariantId);
  }

  /**
   * Refuse a kit that would contain itself at any depth.
   *
   * The table CHECK catches the one-hop case. A three-deep loop needs the chain
   * walked, and an unwalked one is an assembly that recurses until something
   * else stops it.
   */
  private async assertNoCycle(orgId: string, kitVariantId: number, componentIds: readonly number[]) {
    if (componentIds.length === 0) return;
    const rows = await this.db.execute<{ id: number }>(sql`
      WITH RECURSIVE expansion AS (
        SELECT component_variant_id AS id, 1 AS depth
        FROM inv_kit_components
        WHERE org_id = ${orgId}
          AND kit_variant_id IN (${sql.join(componentIds.map((id) => sql`${id}`), sql`, `)})
        UNION ALL
        SELECT kc.component_variant_id, expansion.depth + 1
        FROM inv_kit_components kc
        JOIN expansion ON kc.kit_variant_id = expansion.id
        WHERE kc.org_id = ${orgId} AND expansion.depth < 16
      )
      SELECT DISTINCT id FROM expansion
    `);
    if (rows.some((row) => Number(row.id) === kitVariantId)) {
      throw new BadRequestException(
        "One of those components is itself built from this kit, which would be an endless build",
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Availability
   * ---------------------------------------------------------------- */

  /** How many whole kits the components at this warehouse could make right now. */
  /**
   * How many of this kit the caller could build, out of stock the caller holds.
   *
   * `warehouseId` is optional and comes from the query string, and this took no
   * caller identity at all — so omitting it summed component availability across
   * EVERY warehouse in the organisation, and supplying one read whichever
   * building was named. Either way it answered over stock the asker may hold no
   * part of, while `assemble` beside it calls `assertLocationVisible` before it
   * will move anything.
   *
   * Root CLAUDE.md §5 states the rule this broke: an optional filter that widens
   * scope must be authorized, and the gate must bite. There was no gate.
   *
   * Two halves, and the second is the one that matters. A named warehouse is
   * asserted visible — 404 if not, so it is not an oracle for what exists. An
   * OMITTED one no longer means "everywhere"; it means everywhere the caller
   * holds. A default that widens is the failure this class keeps producing.
   */
  async buildable(
    orgId: string,
    userId: string,
    kitVariantId: number,
    warehouseId?: number | null,
  ): Promise<string> {
    const bom = await this.getBom(orgId, kitVariantId);
    if (bom.length === 0) return "0";

    if (warehouseId != null) {
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, warehouseId);
      const available = await this.availableByComponent(this.db, orgId, bom, warehouseId);
      return buildableKits(bom as BomLine[], available);
    }

    const scope = await this.warehouseScope.resolve(orgId, userId);
    if (scope !== null && scope.length === 0) return "0";
    const available = await this.availableByComponent(this.db, orgId, bom, null, undefined, scope);
    return buildableKits(bom as BomLine[], available);
  }

  private async availableByComponent(
    executor: Tx | Db,
    orgId: string,
    bom: readonly { componentVariantId: number }[],
    warehouseId: number | null,
    locationId?: number | null,
    /** `null` is unrestricted; a list narrows the sum to those warehouses. */
    scope?: number[] | null,
  ): Promise<Map<number, string>> {
    const ids = bom.map((line) => line.componentVariantId);
    if (ids.length === 0) return new Map();

    const rows = await executor.execute<{ product_variant_id: number; available: string }>(sql`
      SELECT sl.product_variant_id, ${availableQtySumSql("sl")} AS available
      FROM inv_stock_levels sl
      JOIN inv_locations loc ON loc.id = sl.location_id AND loc.org_id = sl.org_id
      WHERE sl.org_id = ${orgId}
        AND sl.product_variant_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        ${locationId != null ? sql`AND sl.location_id = ${locationId}` : sql``}
        ${warehouseId != null ? sql`AND loc.warehouse_id = ${warehouseId}` : sql``}
        ${
          scope != null && scope.length > 0
            ? sql`AND loc.warehouse_id IN (${sql.join(scope.map((id) => sql`${id}`), sql`, `)})`
            : sql``
        }
      GROUP BY sl.product_variant_id
    `);

    return new Map(rows.map((r) => [Number(r.product_variant_id), String(r.available)]));
  }

  /* ---------------------------------------------------------------- *
   * Assemble
   * ---------------------------------------------------------------- */

  async assemble(
    orgId: string,
    userId: string,
    input: AssembleKitInput,
    idempotencyKey: string,
  ): Promise<KitAssemblyResult> {
    await this.warehouseScope.assertLocationVisible(orgId, userId, input.locationId);

    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.kit.assemble", ...input },
        () => this.assembleInTx(tx, orgId, userId, input, idempotencyKey),
        (stored) => stored as KitAssemblyResult,
      ),
    );
  }

  private async assembleInTx(
    tx: Tx,
    orgId: string,
    userId: string,
    input: AssembleKitInput,
    idempotencyKey: string,
  ): Promise<KitAssemblyResult> {
    const bom = await this.getBom(orgId, input.kitVariantId);
    const demand = explode(bom as BomLine[], input.quantity);

    // Availability at **this location**, not the warehouse: an assembler stands
    // in one place, and telling them the components are available when they are
    // in another aisle is telling them to walk.
    const available = await this.availableByComponent(
      tx,
      orgId,
      bom,
      null,
      input.locationId,
    );
    const short = shortComponents(demand, available);
    if (short.length > 0) {
      // Every short component, not the first: an assembler told about one, who
      // fixes it and is then told about another, has walked the warehouse twice
      // for information the system had both times.
      throw new BadRequestException({
        code: "KIT_COMPONENTS_SHORT",
        message: `${short.length} component(s) are short at this location`,
        short,
      });
    }

    // Half one: the components leave. Their cost is settled by the engine from
    // the layers they actually drew, which is the figure the kit is then built at.
    const consumed = await this.engine.executeInTx(tx, orgId, userId, {
      idempotencyKey: `${idempotencyKey}:components`,
      sourceType: "inv_kit_assembly",
      sourceId: String(input.kitVariantId),
      reason: `Assemble ${input.quantity} × variant ${input.kitVariantId}`,
      movements: demand.map((line) => ({
        transactionType: "KIT_ASSEMBLE_OUT",
        productVariantId: line.componentVariantId,
        locationId: input.locationId,
        quantityDelta: `-${line.quantityRequired}`,
      })),
    });

    const totalCost = await this.costOf(tx, orgId, consumed.transactionIds);

    // Half two: the kit arrives, at exactly what the components turned out to
    // cost. `settledCost` rather than a unit cost the engine would re-derive:
    // the cost side is already decided, and letting it take the ordinary receipt
    // path would price the kit from its own (non-existent) history.
    const built = await this.engine.executeInTx(tx, orgId, userId, {
      idempotencyKey: `${idempotencyKey}:kit`,
      sourceType: "inv_kit_assembly",
      sourceId: String(input.kitVariantId),
      reason: `Assemble ${input.quantity} × variant ${input.kitVariantId}`,
      movements: [
        {
          transactionType: "KIT_ASSEMBLE_IN",
          productVariantId: input.kitVariantId,
          locationId: input.locationId,
          quantityDelta: input.quantity,
          unitCost: divDec(totalCost, input.quantity),
        },
      ],
    });

    await this.audit.insert(tx, {
      orgId,
      actorUserId: userId,
      action: "kit.assemble",
      resourceType: "inv_product_variant",
      resourceId: String(input.kitVariantId),
      after: { quantity: input.quantity, locationId: input.locationId, totalCost },
      metadata: { components: demand.length },
    });

    return {
      kitVariantId: input.kitVariantId,
      locationId: input.locationId,
      quantity: input.quantity,
      totalCost,
      transactionIds: [...consumed.transactionIds, ...built.transactionIds],
    };
  }

  /* ---------------------------------------------------------------- *
   * Disassemble
   * ---------------------------------------------------------------- */

  /**
   * Break kits back into their components.
   *
   * The kit is issued first so the engine settles what it was actually worth,
   * and that exact figure is then given back to the components in proportion to
   * their share of the build's cost. Value is conserved to the last paise, so a
   * disassembly posts no variance nobody asked for - which is the only way this
   * can be a stock command rather than an accounting one.
   */
  async disassemble(
    orgId: string,
    userId: string,
    input: DisassembleKitInput,
    idempotencyKey: string,
  ): Promise<KitAssemblyResult> {
    await this.warehouseScope.assertLocationVisible(orgId, userId, input.locationId);

    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.kit.disassemble", ...input },
        async () => {
          const bom = await this.getBom(orgId, input.kitVariantId);
          const demand = explode(bom as BomLine[], input.quantity);

          const broken = await this.engine.executeInTx(tx, orgId, userId, {
            idempotencyKey: `${idempotencyKey}:kit`,
            sourceType: "inv_kit_disassembly",
            sourceId: String(input.kitVariantId),
            reason: `Disassemble ${input.quantity} × variant ${input.kitVariantId}`,
            movements: [
              {
                transactionType: "KIT_DISASSEMBLE_OUT",
                productVariantId: input.kitVariantId,
                locationId: input.locationId,
                quantityDelta: `-${input.quantity}`,
              },
            ],
          });

          const totalCost = await this.costOf(tx, orgId, broken.transactionIds);
          const unitCosts = await this.unitCostByVariant(
            tx,
            orgId,
            demand.map((line) => line.componentVariantId),
            input.locationId,
          );
          const shares = apportionKitCost(
            totalCost,
            demand.map((line) => ({
              componentVariantId: line.componentVariantId,
              quantityRequired: line.quantityRequired,
              unitCost: unitCosts.get(line.componentVariantId) ?? "0",
            })),
          );

          const returned = await this.engine.executeInTx(tx, orgId, userId, {
            idempotencyKey: `${idempotencyKey}:components`,
            sourceType: "inv_kit_disassembly",
            sourceId: String(input.kitVariantId),
            reason: `Disassemble ${input.quantity} × variant ${input.kitVariantId}`,
            movements: demand.map((line, index) => ({
              transactionType: "KIT_DISASSEMBLE_IN",
              productVariantId: line.componentVariantId,
              locationId: input.locationId,
              quantityDelta: line.quantityRequired,
              unitCost: divDec(shares[index]!.totalCost, line.quantityRequired),
            })),
          });

          await this.audit.insert(tx, {
            orgId,
            actorUserId: userId,
            action: "kit.disassemble",
            resourceType: "inv_product_variant",
            resourceId: String(input.kitVariantId),
            after: { quantity: input.quantity, locationId: input.locationId, totalCost },
          });

          return {
            kitVariantId: input.kitVariantId,
            locationId: input.locationId,
            quantity: input.quantity,
            totalCost,
            transactionIds: [...broken.transactionIds, ...returned.transactionIds],
          } satisfies KitAssemblyResult;
        },
        (stored) => stored as KitAssemblyResult,
      ),
    );
  }

  /** What a set of movements actually cost, read back off the ledger rows. */
  private async costOf(tx: Tx, orgId: string, transactionIds: readonly number[]): Promise<string> {
    if (transactionIds.length === 0) return "0.0000";
    const rows = await tx
      .select({ totalCost: invStockTransactions.totalCost })
      .from(invStockTransactions)
      .where(
        and(
          eq(invStockTransactions.orgId, orgId),
          inArray(invStockTransactions.id, [...transactionIds]),
        ),
      );

    return rows.reduce((sum, row) => {
      const value = row.totalCost ?? "0";
      // An issue's total cost is negative on the row; the build's cost is what
      // left, so the sign is dropped here rather than by every caller.
      return addDec(sum, cmpDec(value, "0") < 0 ? value.replace("-", "") : value);
    }, "0");
  }

  private async unitCostByVariant(
    tx: Tx,
    orgId: string,
    variantIds: readonly number[],
    locationId: number,
  ): Promise<Map<number, string>> {
    if (variantIds.length === 0) return new Map();
    const rows = await tx.execute<{ product_variant_id: number; average_cost: string | null }>(sql`
      SELECT product_variant_id, average_cost
      FROM inv_stock_levels
      WHERE org_id = ${orgId}
        AND location_id = ${locationId}
        AND product_variant_id IN (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})
    `);
    return new Map(
      rows.map((r) => [Number(r.product_variant_id), String(r.average_cost ?? "0")]),
    );
  }
}
