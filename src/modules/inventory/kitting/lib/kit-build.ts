import { BadRequestException } from "@nestjs/common";
import { type Db } from "../../../../db/drizzle.module";
import type { StockEngineService } from "../../stock-engine/stock-engine.service";
import type { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { divDec } from "../../stock-engine/decimal";
import {
  apportionKitCost,
  explode,
  shortComponents,
  type BomLine,
} from "../kit-math";
import type {
  AssembleKitInput,
  DisassembleKitInput,
} from "../dto/kitting.schemas";
import { availableByComponent, costOf, unitCostByVariant } from "./kit-stock-reads";

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
 * NEO-9 — the two commands that post stock, out of `KitService`.
 *
 * The seam is the one the service's own header describes: a kit is stock, and
 * these are the only two things in kitting that move any. Both are two engine
 * calls under one transaction and one derived key family, with a costing
 * readback wedged between them so the kit is built at what the components
 * actually consumed — assembly settles the issue and prices the receipt from
 * it, disassembly settles the kit and apportions that exact figure back across
 * the components. Everything left behind in the service either edits the bill of
 * materials or answers a question, and posts nothing.
 *
 * Functions over a deps bag rather than a second `@Injectable`, for the reason
 * `sales-orders/so-ship.ts` spells out: these may only ever run *inside* the
 * transaction and the idempotency claim their caller has already opened, and a
 * service holding its own `db` handle is an invitation to forget that.
 */
export interface KitBuildDeps {
  readonly engine: StockEngineService;
  readonly audit: InventoryAuditService;
  /**
   * `KitService.getBom` as a bound closure, at the narrow shape these two read.
   *
   * Passed in rather than imported so the BOM read stays a member of the service
   * that owns the bill of materials, and so `lib/` keeps no edge back into it —
   * `check:cycles` counts a type-only import as one.
   */
  readonly loadBom: (
    orgId: string,
    kitVariantId: number,
  ) => Promise<Array<{ componentVariantId: number; quantityPer: string }>>;
}

export async function assembleKitInTx(
  deps: KitBuildDeps,
  tx: Tx,
  orgId: string,
  userId: string,
  input: AssembleKitInput,
  idempotencyKey: string,
): Promise<KitAssemblyResult> {
  const bom = await deps.loadBom(orgId, input.kitVariantId);
  const demand = explode(bom as BomLine[], input.quantity);

  // Availability at **this location**, not the warehouse: an assembler stands
  // in one place, and telling them the components are available when they are
  // in another aisle is telling them to walk.
  const available = await availableByComponent(
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
  const consumed = await deps.engine.executeInTx(tx, orgId, userId, {
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

  const totalCost = await costOf(tx, orgId, consumed.transactionIds);

  // Half two: the kit arrives, at exactly what the components turned out to
  // cost. `settledCost` rather than a unit cost the engine would re-derive:
  // the cost side is already decided, and letting it take the ordinary receipt
  // path would price the kit from its own (non-existent) history.
  const built = await deps.engine.executeInTx(tx, orgId, userId, {
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

  await deps.audit.insert(tx, {
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

/**
 * Break kits back into their components.
 *
 * The kit is issued first so the engine settles what it was actually worth, and
 * that exact figure is then given back to the components in proportion to their
 * share of the build's cost. Value is conserved to the last paise, so a
 * disassembly posts no variance nobody asked for - which is the only way this
 * can be a stock command rather than an accounting one.
 */
export async function disassembleKitInTx(
  deps: KitBuildDeps,
  tx: Tx,
  orgId: string,
  userId: string,
  input: DisassembleKitInput,
  idempotencyKey: string,
): Promise<KitAssemblyResult> {
  const bom = await deps.loadBom(orgId, input.kitVariantId);
  const demand = explode(bom as BomLine[], input.quantity);

  const broken = await deps.engine.executeInTx(tx, orgId, userId, {
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

  const totalCost = await costOf(tx, orgId, broken.transactionIds);
  const unitCosts = await unitCostByVariant(
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

  const returned = await deps.engine.executeInTx(tx, orgId, userId, {
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

  await deps.audit.insert(tx, {
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
}
