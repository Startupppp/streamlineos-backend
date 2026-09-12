import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { invKitComponents } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { buildableKits, type BomLine } from "./kit-math";
import type {
  AssembleKitInput,
  DisassembleKitInput,
  SetKitBomInput,
} from "./dto/kitting.schemas";
import { availableByComponent } from "./lib/kit-stock-reads";
import {
  assembleKitInTx,
  disassembleKitInTx,
  type KitAssemblyResult,
  type KitBuildDeps,
} from "./lib/kit-build";

/**
 * Re-exported so the service's public surface is what it always was. The
 * declaration moved with the two commands that produce it rather than being
 * imported back the other way, because `check:cycles` counts a type-only import
 * from `lib/` into the service as an edge.
 */
export type { KitAssemblyResult } from "./lib/kit-build";

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

  /**
   * `getBom` is handed over bound rather than exported, so the bill of materials
   * stays a member of the service that owns it and `lib/` keeps no edge back.
   */
  private get buildDeps(): KitBuildDeps {
    return {
      engine: this.engine,
      audit: this.audit,
      loadBom: (orgId, kitVariantId) => this.getBom(orgId, kitVariantId),
    };
  }

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
      const available = await availableByComponent(this.db, orgId, bom, warehouseId);
      return buildableKits(bom as BomLine[], available);
    }

    const scope = await this.warehouseScope.resolve(orgId, userId);
    if (scope !== null && scope.length === 0) return "0";
    const available = await availableByComponent(this.db, orgId, bom, null, undefined, scope);
    return buildableKits(bom as BomLine[], available);
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
        () => assembleKitInTx(this.buildDeps, tx, orgId, userId, input, idempotencyKey),
        (stored) => stored as KitAssemblyResult,
      ),
    );
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
        () => disassembleKitInTx(this.buildDeps, tx, orgId, userId, input, idempotencyKey),
        (stored) => stored as KitAssemblyResult,
      ),
    );
  }
}
