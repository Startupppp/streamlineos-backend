import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { invPoLines, invProposalOverrides, invPurchaseOrders } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { AccessService } from "../../../access/access.service";
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
import { resolve, type QueryExecutor } from "./lib/batch-resolve";

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

  /**
   * One persisted proposal, resolved exactly as the batchable list resolves it.
   *
   * F4 needs a single proposal rather than a page of them, and it must be the
   * *same* resolution — the same reorder point, the same live position, the same
   * `applyOrderPolicy` rounding, the same duplicate check. A caller that
   * assembled its own version of this would be a second answer to "how much
   * would we order", and the AI surface is the last place that should hold one.
   *
   * `null` rather than a throw for an id that resolves to nothing: a proposal
   * belonging to another organisation and a proposal that has been superseded
   * are indistinguishable from outside, and §4 requires the caller to render
   * both as 404 rather than confirming which it was.
   */
  async proposalById(
    orgId: string,
    userId: string,
    proposalId: number,
  ): Promise<BatchableProposal | null> {
    const [row] = await resolve(this.db, orgId, [proposalId]);
    if (!row) return null;
    // The same warehouse gate `resolveForBatching` applies before an order is
    // raised. Reading a proposal for a site the caller cannot open would be a
    // way to read that site's position by asking the AI about it.
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, row.warehouseId);
    return toBatchableProposal(row);
  }

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

    const rows = await resolve(this.db, orgId, idRows.map((r) => Number(r.id)));
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
    validateBatchOverrides(input.proposalIds, overrides);
    const settings = await this.settings.get(orgId);

    return this.db.transaction((tx) =>
      runIdempotent<CreatedPoBatch>(
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
        async () => {
          const resolution = await this.resolveForBatching(
            orgId,
            userId,
            input.proposalIds,
            overrides,
            tx,
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
          const stored = await this.insertDraftPo(tx, orgId, userId, batch, overridden);
          return {
            poId: stored.poId,
            poNumber: stored.poNumber,
            vendorId: batch.vendorId,
            warehouseId: batch.warehouseId,
            currency: batch.currency,
            lineCount: batch.lines.length,
            total: batch.totalValue,
            requiresApproval: batch.requiresApproval,
            nextStep: batch.requiresApproval
              ? "This organisation requires approval, so the draft has to be approved before it can be sent."
              : "The draft can be sent to the supplier without a separate approval.",
            created: true,
          };
        },
        reviveBatch,
      ),
    );
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
    executor: QueryExecutor = this.db,
  ): Promise<ProposalResolution> {
    const unique = [...new Set(proposalIds)];
    validateBatchOverrides(unique, overrides);

    const rows = await resolve(this.db, orgId, unique, executor);
    if (rows.length !== unique.length) {
      // A missing id is a 404 rather than a 403 even when it belongs to another
      // tenant: a 403 would confirm the row exists (§4).
      throw new NotFoundException("One or more of these proposals no longer exists.");
    }
    for (const row of rows)
      await this.warehouseScope.assertWarehouseVisible(orgId, userId, row.warehouseId);
    return resolveProposalLines(rows, overrides);
  }

}

interface StoredBatch {
  poId: number;
  poNumber: string;
  created: boolean;
}

/** The stored response is JSON that has been through Postgres; rebuild it. */
function reviveBatch(stored: unknown): CreatedPoBatch {
  const row =
    typeof stored === "object" && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  return {
    poId: Number(row.poId ?? 0),
    poNumber: String(row.poNumber ?? ""),
    vendorId: Number(row.vendorId ?? 0),
    warehouseId:
      row.warehouseId === null || row.warehouseId === undefined
        ? null
        : Number(row.warehouseId),
    currency: String(row.currency ?? "USD"),
    lineCount: Number(row.lineCount ?? 0),
    total: String(row.total ?? "0"),
    requiresApproval: Boolean(row.requiresApproval),
    nextStep: String(row.nextStep ?? ""),
    created: false,
  };
}

function validateBatchOverrides(
  proposalIds: readonly number[],
  overrides: readonly ProposalOverride[],
): void {
  const selected = new Set(proposalIds);
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
