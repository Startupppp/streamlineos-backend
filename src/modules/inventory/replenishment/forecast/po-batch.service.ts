import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { invPoLines, invProposalOverrides, invPurchaseOrders } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { AccessService } from "../../../access/access.service";
import { availableQtySumSql } from "../../stock-engine/available-sql";
import { addDec } from "../../stock-engine/decimal";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../../stock-engine/idempotency";
import { batchProposals, type SupplierSiteBatch } from "./order-policy";
import {
  assertSingleSupplierSite,
  blockedReason,
  orderQuantityFor,
  resolveProposalLines,
  type ProposalOverride,
  type ProposalResolution,
  type ResolvedBatchLine,
  type ResolvedProposalRow,
} from "./po-batch-lines";
import { assertMayCreatePurchaseOrder } from "./purchase-order-authority";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface BatchableProposal {
  proposalId: number;
  productVariantId: number;
  variantSku: string;
  productName: string;
  warehouseId: number | null;
  warehouseName: string | null;
  vendorId: number | null;
  vendorName: string | null;
  currency: string | null;
  generatedAt: string;
  reorderPoint: string | null;
  /** Exact decimal string — what the server would order, today. */
  suggestedQuantity: string;
  unitCost: string;
  duplicateOfPoNumber: string | null;
  blockedReason: string | null;
}

export interface PoBatchPreview {
  batches: SupplierSiteBatch[];
  /** Proposals that produce no order line, and why. Never silently dropped. */
  skipped: Array<{ proposalId: number; productVariantId: number; reason: string }>;
  requiresApproval: boolean;
}

export interface CreatedPoBatch {
  poId: number;
  poNumber: string;
  vendorId: number;
  warehouseId: number | null;
  currency: string;
  lineCount: number;
  total: string;
  requiresApproval: boolean;
  /** What has to happen before goods can be expected. */
  nextStep: string;
  created: boolean;
}

/**
 * C6 — one purchase order per supplier, site and currency.
 *
 * The persisted proposal is the authority for *what* is needed: an
 * `inv_demand_forecasts` row carries the reorder point that version committed
 * to. The live ledger is the authority for *how much is still needed*, because
 * a proposal recorded on Monday is not a claim about Friday's position. So the
 * quantity is `reorder point − (available + on order)`, exact throughout, put
 * through the supplier's minimum and pack size — and a quantity in the request
 * body is not read at all. The schema has no field for one.
 *
 * **Duplicate detection has no table of its own.** A proposal is already batched
 * when an unsent DRAFT order for the same supplier and site already carries a
 * line for that variant. That is the real condition a buyer cares about, it
 * catches orders raised through `generatePo` and by hand as well as through this
 * service, and it cannot drift out of step with the orders it describes the way
 * a separate ledger of "what we batched" would. Sent orders need no rule here:
 * their units are already in `on_order` and the arithmetic above has subtracted
 * them.
 */
@Injectable()
export class PoBatchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: InventorySettingsService,
    private readonly numSeq: NumberSequenceService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly access: AccessService,
  ) {}

  /** The persisted proposals a buyer could act on, newest version per site. */
  async batchable(
    orgId: string,
    userId: string,
    query: { warehouseId?: number; vendorId?: number; page: number; limit: number },
  ): Promise<{ items: BatchableProposal[]; total: number; page: number; totalPages: number }> {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const empty = { items: [], total: 0, page: query.page, totalPages: 0 };
    if (scope.isEmpty) return empty;

    const warehouseFilter =
      query.warehouseId === undefined
        ? sql`TRUE`
        : sql`f.warehouse_id = ${query.warehouseId}`;

    const latest = sql`
      SELECT DISTINCT ON (f.product_variant_id, f.warehouse_id) f.id
      FROM inv_demand_forecasts f
      WHERE f.org_id = ${orgId}
        AND f.applicable = true
        AND f.reorder_point IS NOT NULL
        AND ${warehouseFilter}
        AND ${scope.warehouse(sql`f.warehouse_id`)}
      ORDER BY f.product_variant_id, f.warehouse_id, f.generated_at DESC, f.id DESC
    `;

    const [countRow] = await this.db.execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM (${latest}) latest`,
    );
    const total = Number(countRow?.total ?? 0);
    if (total === 0) return empty;

    const idRows = await this.db.execute<{ id: number }>(sql`
      SELECT id FROM (${latest}) latest
      ORDER BY id DESC
      LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}
    `);

    const rows = await this.resolve(orgId, idRows.map((r) => Number(r.id)));
    const items = rows
      .filter((row) => query.vendorId === undefined || row.vendorId === query.vendorId)
      .map(toBatchableProposal);

    return {
      items,
      total,
      page: query.page,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  /** What would be created, grouped, without writing anything. */
  async preview(
    orgId: string,
    userId: string,
    proposalIds: readonly number[],
    overrides: readonly ProposalOverride[] = [],
  ): Promise<PoBatchPreview> {
    const settings = await this.settings.get(orgId);
    const resolution = await this.resolveForBatching(
      orgId,
      userId,
      proposalIds,
      overrides,
    );
    return {
      batches: batchProposals(resolution.lines, {
        requireApproval: settings.requirePoApproval,
        approvalThreshold: null,
      }),
      skipped: resolution.skipped,
      requiresApproval: settings.requirePoApproval,
    };
  }

  /**
   * Create the one draft order this set of proposals describes.
   *
   * A set spanning two suppliers, two sites or two currencies is refused rather
   * than split: a purchase order has one vendor, one delivery warehouse and one
   * currency on its header, so "create the orders for this set" is a different
   * command from "create this order", and quietly picking one of the groups is
   * the worst available answer.
   */
  async create(
    orgId: string,
    userId: string,
    input: {
      proposalIds: readonly number[];
      vendorId: number;
      overrides?: readonly ProposalOverride[];
    },
    idempotencyKey: string,
  ): Promise<CreatedPoBatch> {
    // Asserted here as well as on the route. `PermissionGuard` is not global
    // (backend §2), so a controller added beside `InvPoBatchesController` that
    // forgets `@RequirePermission` would be authenticated, module-gated and
    // free to raise purchase orders; this is the check it cannot route around.
    await assertMayCreatePurchaseOrder(this.access, orgId, userId);

    const overrides = input.overrides ?? [];
    const settings = await this.settings.get(orgId);
    const resolution = await this.resolveForBatching(
      orgId,
      userId,
      input.proposalIds,
      overrides,
    );

    if (resolution.lines.length === 0) {
      throw new BadRequestException(
        resolution.skipped[0]?.reason ??
          "None of these proposals still need ordering — the shortfall has already been met.",
      );
    }

    const batches = batchProposals(resolution.lines, {
      requireApproval: settings.requirePoApproval,
      approvalThreshold: null,
    });
    assertSingleSupplierSite(batches, input.vendorId);
    const batch = batches[0];
    if (!batch) {
      throw new BadRequestException("This set of proposals produces no purchase order.");
    }

    const overridden = resolution.lines.filter((line) => line.override !== null);

    const result = await this.db.transaction((tx) =>
      runIdempotent<StoredBatch>(
        tx,
        orgId,
        idempotencyKey,
        {
          command: "inventory.replenishment.po-batch.create",
          vendorId: input.vendorId,
          proposalIds: [...input.proposalIds].sort((a, b) => a - b),
          // The overrides are part of the request, so they are part of its
          // identity. Left out, a retry that changed a quantity would replay the
          // first order and report success for a number nobody ordered — and
          // `runIdempotent` raises a parameter mismatch instead.
          overrides: [...overrides]
            .sort((a, b) => a.proposalId - b.proposalId)
            .map((o) => [o.proposalId, o.quantity, o.reason]),
        },
        () => this.insertDraftPo(tx, orgId, userId, batch, overridden),
        reviveBatch,
      ),
    );

    return {
      poId: result.poId,
      poNumber: result.poNumber,
      vendorId: batch.vendorId,
      warehouseId: batch.warehouseId,
      currency: batch.currency,
      lineCount: batch.lines.length,
      total: batch.totalValue,
      requiresApproval: batch.requiresApproval,
      nextStep: batch.requiresApproval
        ? "This organisation requires approval, so the draft has to be approved before it can be sent."
        : "The draft can be sent to the supplier without a separate approval.",
      created: result.created,
    };
  }

  private async insertDraftPo(
    tx: Tx,
    orgId: string,
    userId: string,
    batch: SupplierSiteBatch,
    overridden: readonly ResolvedBatchLine[],
  ): Promise<StoredBatch> {
    const poNumber = await this.numSeq.next(orgId, "PO", tx);
    const subtotal = batch.lines.reduce(
      (sum, line) => addDec(sum, line.lineValue),
      "0",
    );

    const [po] = await tx
      .insert(invPurchaseOrders)
      .values({
        orgId,
        vendorId: batch.vendorId,
        poNumber,
        status: "DRAFT",
        orderDate: new Date().toISOString().slice(0, 10),
        warehouseId: batch.warehouseId,
        subtotal,
        taxAmount: "0",
        discount: "0",
        total: subtotal,
        currency: batch.currency,
        createdBy: userId,
      })
      .returning({ id: invPurchaseOrders.id, poNumber: invPurchaseOrders.poNumber });
    if (!po) throw new BadRequestException("The draft purchase order could not be created.");

    await tx.insert(invPoLines).values(
      batch.lines.map((line, index) => ({
        orgId,
        poId: po.id,
        productVariantId: line.productVariantId,
        quantity: line.ordered,
        quantityReceived: "0",
        unitCost: line.unitCost,
        taxRate: "0",
        amount: line.lineValue,
        lineOrder: index,
      })),
    );

    // C2. Written in the same transaction as the order it explains. A separate
    // write could fail on its own and leave a purchase order carrying a human's
    // number with nothing on record saying it was one — which is the state the
    // whole unit exists to make impossible.
    const overrideRows = overridden.flatMap((line) =>
      line.override === null
        ? []
        : [
            {
              orgId,
              forecastId: line.proposalId,
              productVariantId: line.productVariantId,
              warehouseId: line.warehouseId,
              engineQty: line.engineOrdered,
              requestedQty: line.override.requested,
              orderedQty: line.ordered,
              reason: line.override.reason,
              poId: po.id,
              createdBy: userId,
            },
          ],
    );
    if (overrideRows.length > 0) await tx.insert(invProposalOverrides).values(overrideRows);

    return { poId: po.id, poNumber: po.poNumber, created: true };
  }

  /** Resolve, gate and price every named proposal, keeping the refusals. */
  private async resolveForBatching(
    orgId: string,
    userId: string,
    proposalIds: readonly number[],
    overrides: readonly ProposalOverride[],
  ): Promise<ProposalResolution> {
    const unique = [...new Set(proposalIds)];
    // An override naming a proposal that is not in the batch would be accepted
    // and silently do nothing, which is the shape of bug that makes a buyer
    // believe they changed a quantity they did not. Refused instead.
    const selected = new Set(unique);
    const stray = overrides.find((o) => !selected.has(o.proposalId));
    if (stray) {
      throw new BadRequestException(
        `An override was given for proposal ${stray.proposalId}, which is not in this batch.`,
      );
    }
    const seen = new Set<number>();
    for (const override of overrides) {
      if (seen.has(override.proposalId)) {
        throw new BadRequestException(
          `Proposal ${override.proposalId} was overridden twice, and the two do not agree on a quantity.`,
        );
      }
      seen.add(override.proposalId);
    }

    const rows = await this.resolve(orgId, unique);
    if (rows.length !== unique.length) {
      // A missing id is a 404 rather than a 403 even when it belongs to another
      // tenant: a 403 would confirm the row exists (§4).
      throw new NotFoundException("One or more of these proposals no longer exists.");
    }
    for (const row of rows)
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, row.warehouseId);
    return resolveProposalLines(rows, overrides);
  }

  /**
   * Everything a proposal needs to become an order line, in one query.
   *
   * The lateral joins are deliberate: a per-proposal round trip for the
   * position, the last paid price and the open-draft check is three queries per
   * SKU, and a batch is dozens of SKUs. `availableQtySumSql` is the one
   * availability formula (`available-sql.ts`) — writing the subtraction out here
   * is how the six copies A1 removed came about.
   */
  private async resolve(
    orgId: string,
    proposalIds: readonly number[],
  ): Promise<ResolvedProposalRow[]> {
    if (proposalIds.length === 0) return [];
    const rows = await this.db.execute<{
      proposal_id: number;
      product_variant_id: number;
      warehouse_id: number | null;
      warehouse_name: string | null;
      reorder_point: string | null;
      applicable: boolean;
      refusal_reason: string | null;
      generated_at: Date;
      variant_sku: string;
      product_name: string;
      min_order_qty: string | null;
      order_multiple: string | null;
      vendor_id: number | null;
      vendor_name: string | null;
      currency: string | null;
      available: string;
      on_order: string;
      last_unit_cost: string | null;
      duplicate_po_id: number | null;
      duplicate_po_number: string | null;
    }>(sql`
      SELECT f.id AS proposal_id,
             f.product_variant_id,
             f.warehouse_id,
             w.name AS warehouse_name,
             f.reorder_point,
             f.applicable,
             f.refusal_reason,
             f.generated_at,
             pv.sku AS variant_sku,
             p.name AS product_name,
             p.min_order_qty,
             p.order_multiple,
             v.id AS vendor_id,
             v.name AS vendor_name,
             v.currency,
             COALESCE(pos.available, '0')::text AS available,
             COALESCE(pos.on_order, '0')::text AS on_order,
             last_cost.unit_cost AS last_unit_cost,
             draft.po_id AS duplicate_po_id,
             draft.po_number AS duplicate_po_number
      FROM inv_demand_forecasts f
      JOIN inv_product_variants pv
        ON pv.org_id = f.org_id AND pv.id = f.product_variant_id
      JOIN inv_products p
        ON p.org_id = pv.org_id AND p.id = pv.product_id
      LEFT JOIN inv_warehouses w
        ON w.org_id = f.org_id AND w.id = f.warehouse_id
      LEFT JOIN inv_reorder_rules rr
        ON rr.org_id = f.org_id
       AND rr.product_variant_id = f.product_variant_id
       AND rr.warehouse_id IS NOT DISTINCT FROM f.warehouse_id
       AND rr.is_active = true
      LEFT JOIN inv_vendors v
        ON v.org_id = f.org_id AND v.id = COALESCE(rr.vendor_id, p.default_vendor_id)
      LEFT JOIN LATERAL (
        SELECT ${availableQtySumSql("sl")}::text AS available,
               COALESCE(SUM(sl.on_order), 0)::text AS on_order
        FROM inv_stock_levels sl
        WHERE sl.org_id = f.org_id
          AND sl.product_variant_id = f.product_variant_id
          AND (
            f.warehouse_id IS NULL
            OR EXISTS (
              SELECT 1 FROM inv_locations pos_loc
              WHERE pos_loc.id = sl.location_id
                AND pos_loc.org_id = sl.org_id
                AND pos_loc.warehouse_id = f.warehouse_id
            )
          )
      ) pos ON TRUE
      LEFT JOIN LATERAL (
        SELECT pl.unit_cost
        FROM inv_po_lines pl
        JOIN inv_purchase_orders po ON po.org_id = pl.org_id AND po.id = pl.po_id
        WHERE pl.org_id = f.org_id
          AND pl.product_variant_id = f.product_variant_id
          AND po.vendor_id = COALESCE(rr.vendor_id, p.default_vendor_id)
        ORDER BY po.order_date DESC, po.id DESC
        LIMIT 1
      ) last_cost ON TRUE
      LEFT JOIN LATERAL (
        SELECT po.id AS po_id, po.po_number
        FROM inv_purchase_orders po
        JOIN inv_po_lines pl ON pl.org_id = po.org_id AND pl.po_id = po.id
        WHERE po.org_id = f.org_id
          AND po.status = 'DRAFT'
          AND pl.product_variant_id = f.product_variant_id
          AND po.vendor_id = COALESCE(rr.vendor_id, p.default_vendor_id)
          AND po.warehouse_id IS NOT DISTINCT FROM f.warehouse_id
        ORDER BY po.id DESC
        LIMIT 1
      ) draft ON TRUE
      WHERE f.org_id = ${orgId}
        AND f.id IN (${sql.join(proposalIds.map((id) => sql`${id}`), sql`, `)})
    `);

    return rows.map((row) => ({
      proposalId: Number(row.proposal_id),
      productVariantId: Number(row.product_variant_id),
      warehouseId: row.warehouse_id === null ? null : Number(row.warehouse_id),
      warehouseName: row.warehouse_name,
      reorderPoint: row.reorder_point,
      applicable: row.applicable,
      refusalReason: row.refusal_reason,
      generatedAt: new Date(row.generated_at).toISOString(),
      variantSku: row.variant_sku,
      productName: row.product_name,
      minOrderQty: row.min_order_qty,
      orderMultiple: row.order_multiple,
      vendorId: row.vendor_id === null ? null : Number(row.vendor_id),
      vendorName: row.vendor_name,
      currency: row.currency,
      available: row.available,
      onOrder: row.on_order,
      lastUnitCost: row.last_unit_cost,
      duplicatePoNumber: row.duplicate_po_number,
    }));
  }
}

interface StoredBatch {
  poId: number;
  poNumber: string;
  created: boolean;
}

/** The stored response is JSON that has been through Postgres; rebuild it. */
function reviveBatch(stored: unknown): StoredBatch {
  const row =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  return {
    poId: Number(row.poId ?? 0),
    poNumber: String(row.poNumber ?? ""),
    created: false,
  };
}

function toBatchableProposal(row: ResolvedProposalRow): BatchableProposal {
  const rounded = orderQuantityFor(row);
  return {
    proposalId: row.proposalId,
    productVariantId: row.productVariantId,
    variantSku: row.variantSku,
    productName: row.productName,
    warehouseId: row.warehouseId,
    warehouseName: row.warehouseName,
    vendorId: row.vendorId,
    vendorName: row.vendorName,
    currency: row.currency,
    generatedAt: row.generatedAt,
    reorderPoint: row.reorderPoint,
    suggestedQuantity: rounded.ordered,
    unitCost: row.lastUnitCost ?? "0.0000",
    duplicateOfPoNumber: row.duplicatePoNumber,
    blockedReason: blockedReason(row, rounded.ordered),
  };
}
