import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ScopedRead } from "../../access/scoped-read";
import {
  invStockAdjustments, invStockAdjustmentLines, invProductVariants, invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { StockMovementBridgeService } from "../../accounting/adapters/stock-movement-bridge.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { CostVisibilityService } from "../stock-engine/cost-visibility";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { ListAdjustmentsInput, CreateAdjustmentInput } from "./dto/inv-stock.schemas";
import { loadCorrectableVariants } from "../products/lib/orderable-variants";
import {
  WRITE_OFF_REASONS,
  assertWriteOffRemovesStock,
  isWriteOffReason,
  withoutWriteOffValue,
} from "./lib/write-off";
import {
  needsApproval as adjustmentNeedsApproval,
  resolveScrapLocation,
} from "./lib/adjustment-approval";
import { applyAdjustmentLinesInTx, type PostableAdjustment } from "./lib/adjustment-posting";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class InvStockAdjustmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly settings: InventorySettingsService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly costVisibility: CostVisibilityService,
    private readonly glBridge: StockMovementBridgeService,
  ) {}

  async listAdjustments(read: ScopedRead, filters: ListAdjustmentsInput) {
    const orgId = read.orgId;
    const { status, reason, writeOffsOnly, page, limit } = filters;
    const offset = (page - 1) * limit;

    // Locations live on the lines, not the header, so scope via EXISTS.
    const warehouses = await this.warehouseScope.resolve(orgId, read.actorId);
    const warehouseIds = warehouses !== null ? this.warehouseScope.warehouseIdList(warehouses) : undefined;
    const warehousePredicate =
      warehouses === null
        ? undefined
        : warehouseIds === null
          ? sql`FALSE`
          : sql`EXISTS (
              SELECT 1 FROM inv_stock_adjustment_lines l
              JOIN inv_locations loc ON loc.id = l.location_id
              WHERE l.adjustment_id = ${invStockAdjustments.id} AND loc.warehouse_id IN (${warehouseIds})
            )`;

    return read.read(
      {
        tenant: invStockAdjustments.orgId,
        scope: { columns: { ownerColumn: invStockAdjustments.createdBy } },
        and: [
          status ? eq(invStockAdjustments.status, status) : undefined,
          reason ? eq(invStockAdjustments.reason, reason) : undefined,
          // D8. The write-off queue is one predicate over the reason, not a second
          // table to keep in step with this one.
          writeOffsOnly ? inArray(invStockAdjustments.reason, [...WRITE_OFF_REASONS]) : undefined,
          warehousePredicate,
        ],
      },
      async ({ sql: where }) => {
        const [items, countResult] = await Promise.all([
          this.db.query.invStockAdjustments.findMany({
            where,
            orderBy: [desc(invStockAdjustments.createdAt)],
            limit,
            offset,
            with: {
              creator: { columns: { id: true, name: true } },
              approver: { columns: { id: true, name: true } },
              poster: { columns: { id: true, name: true } },
              lines: true,
            },
          }),
          this.db.select({ count: sql<number>`count(*)::int` }).from(invStockAdjustments).where(where),
        ]);

        const showCost = await this.costVisibility.canSeeCost(orgId, read.actorId);
        return {
          items: showCost ? items : items.map(withoutWriteOffValue),
          total: countResult[0]?.count ?? 0,
          page,
          totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
        };
      },
      () => ({ items: [], total: 0, page, totalPages: 0 }),
    );
  }

  /**
   * The warehouse gate every id-taking method here goes through.
   *
   * `listAdjustments` scopes -- an adjustment is in scope when any of its lines
   * sits in a location in one of the caller's warehouses -- and `getAdjustment`,
   * `approveAdjustment`, `postAdjustment` and `cancelAdjustment` all reached the
   * row on `org_id` and the id alone. The controller had `@CurrentUser()` in
   * hand for three of them and spent it only on cost visibility; the fourth was
   * never given it at all.
   *
   * **The stock was never at risk and that is exactly why this survived.**
   * `StockEngineService.executeInTx` calls `assertLocationsInScope` on every
   * movement, so posting an out-of-scope adjustment is refused there. What was
   * unguarded is the DOCUMENT: reading another building's write-off with its
   * lines, locations and value; approving one, which satisfies maker-checker for
   * a warehouse you have no standing in and leaves an in-scope poster free to
   * post it; and cancelling one, which is tamper rather than theft but is still
   * somebody else's queue.
   *
   * Deliberately the SAME predicate as the list rather than a house rule. An
   * adjustment all of whose lines sit in location rows with no warehouse matches
   * neither, so the detail and the aggregate agree about it -- which is the
   * property that matters, since they disagree per table on purpose.
   *
   * 404 and not 403: a 403 on an id the caller may not see confirms it exists.
   */
  private async requireAdjustment(orgId: string, userId: string, adjustmentId: number): Promise<void> {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    if (scope === null) return;

    const ids = this.warehouseScope.warehouseIdList(scope);
    const [visible] = await this.db
      .select({ id: invStockAdjustments.id })
      .from(invStockAdjustments)
      .where(and(
        eq(invStockAdjustments.orgId, orgId),
        eq(invStockAdjustments.id, adjustmentId),
        ids === null ? sql`FALSE` : sql`EXISTS (
          SELECT 1 FROM inv_stock_adjustment_lines l
          JOIN inv_locations loc ON loc.id = l.location_id
          WHERE l.adjustment_id = ${invStockAdjustments.id} AND loc.warehouse_id IN (${ids})
        )`,
      ))
      .limit(1);
    if (!visible) throw new NotFoundException("Adjustment not found");
  }

  async getAdjustment(orgId: string, adjustmentId: number, userId: string) {
    await this.requireAdjustment(orgId, userId, adjustmentId);
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
      with: {
        creator: { columns: { id: true, name: true } },
        approver: { columns: { id: true, name: true } },
        poster: { columns: { id: true, name: true } },
        scrapLocation: { columns: { id: true, name: true, code: true } },
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            location: { columns: { id: true, name: true, code: true } },
          },
        },
      },
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    const showCost = await this.costVisibility.canSeeCost(orgId, userId);
    return showCost ? adj : withoutWriteOffValue(adj);
  }

  /**
   * Every variant and location a line names, checked against this organisation.
   *
   * The lines used to go straight in and let the foreign keys decide. A client
   * naming a variant that does not exist got a raw 23503 through
   * `AllExceptionsFilter` — a 500 for what is plainly a bad request, with the
   * failed statement in the log and nothing useful in the response.
   *
   * Scoped to `orgId` as well as to existence, which the foreign keys cannot do:
   * they are on the id alone, so another tenant's variant id would have
   * satisfied them. That is the check that has to happen here or nowhere.
   *
   * Not redundant with the two gates below it. `loadCorrectableVariants` only
   * refuses a variant it FOUND and whose product is deleted — an id it did not
   * find is simply absent from its map — and `assertLocationsInScope` returns
   * early for an unrestricted caller, so neither says "not this organisation's".
   */
  private async assertLinesResolve(
    orgId: string,
    lines: CreateAdjustmentInput["lines"],
  ): Promise<void> {
    const variantIds = [...new Set(lines.map((line) => line.productVariantId))];
    const locationIds = [...new Set(lines.map((line) => line.locationId))];

    const [variants, locations] = await Promise.all([
      this.db
        .select({ id: invProductVariants.id })
        .from(invProductVariants)
        .where(and(eq(invProductVariants.orgId, orgId), inArray(invProductVariants.id, variantIds))),
      this.db
        .select({ id: invLocations.id })
        .from(invLocations)
        .where(and(eq(invLocations.orgId, orgId), inArray(invLocations.id, locationIds))),
    ]);

    const missingVariant = variantIds.find(
      (id) => !variants.some((row) => row.id === id),
    );
    if (missingVariant !== undefined)
      throw new NotFoundException(`No product variant ${String(missingVariant)} in this organisation`);

    const missingLocation = locationIds.find(
      (id) => !locations.some((row) => row.id === id),
    );
    if (missingLocation !== undefined)
      throw new NotFoundException(`No location ${String(missingLocation)} in this organisation`);
  }

  /**
   * A3. The key reached this method and only one of its two branches used it.
   *
   * Below the approval threshold the adjustment posts immediately and the key
   * went to the engine, so the *movement* was protected. Above it the command
   * stopped at PENDING_APPROVAL and claimed nothing at all — a retried create
   * raised a second adjustment document with its own reference number and its
   * own lines, and both of them were then approvable and postable. That is the
   * write-off path, where a duplicate is not a cosmetic problem.
   *
   * The claim therefore wraps the whole command rather than the posting half of
   * it, and the engine is given a derived key: the same key claimed twice in
   * one transaction is a duplicate, not a nesting.
   */
  async createAdjustment(orgId: string, userId: string, data: CreateAdjustmentInput, idempotencyKey: string) {
    await this.assertLinesResolve(orgId, data.lines);

    // A4. The correction gate, not the demand gate: writing off or recounting a
    // discontinued SKU is exactly what an operator does with retired stock, so
    // only a product deleted from the catalogue is refused here.
    const variants = await loadCorrectableVariants(this.db, orgId, data.lines.map((l) => l.productVariantId));

    // D8. A write-off is an adjustment with a condemning reason, so the two
    // rules that only make sense for one are asserted for one.
    const writeOff = isWriteOffReason(data.reason);
    if (writeOff) assertWriteOffRemovesStock(data.reason, data.lines);
    else if (data.scrapLocationId !== undefined) {
      throw new BadRequestException(
        `A scrap location only applies to a write-off (${WRITE_OFF_REASONS.join(", ")}), not to a ${data.reason} adjustment`,
      );
    }
    const scrapLocationId = writeOff
      ? await resolveScrapLocation(this.db, orgId, data.lines, data.scrapLocationId)
      : null;

    const needsApproval = await adjustmentNeedsApproval(
      this.db,
      orgId,
      await this.settings.get(orgId),
      data.lines,
      variants,
    );

    const adjustmentId = await this.db.transaction(async (tx) => {
      /*
        The locations arrive in the BODY, so they are the caller's claim and not
        something already checked. The engine refuses an out-of-scope MOVEMENT,
        which is why nothing was ever moved -- but over the approval threshold
        this command stops at PENDING_APPROVAL and posts nothing, so the engine
        never sees it and the document simply exists, naming another building's
        locations and sitting in that building's queue. Same reasoning as
        `createCycleCount`, which documents the body-is-a-claim rule.
      */
      await this.warehouseScope.assertLocationsInScope(
        tx, orgId, userId, data.lines.map((line) => line.locationId),
      );
      return runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        data,
        async () => {
          const refNum = await this.numSeq.next(orgId, "ADJUSTMENT", tx);
          const [adj] = await tx.insert(invStockAdjustments).values({
            orgId,
            referenceNumber: refNum,
            reason: data.reason,
            notes: data.notes,
            scrapLocationId,
            status: needsApproval ? "PENDING_APPROVAL" : "PENDING_POST",
            createdBy: userId,
          }).returning({ id: invStockAdjustments.id, refNum: invStockAdjustments.referenceNumber });
          if (!adj) throw new ConflictException("Could not open the adjustment");

          await tx.insert(invStockAdjustmentLines).values(
            data.lines.map((line) => ({
              orgId,
              adjustmentId: adj.id,
              productVariantId: line.productVariantId,
              locationId: line.locationId,
              quantityChange: line.quantityChange.toString(),
              notes: line.notes,
            }))
          );

          if (!needsApproval) {
            const stored = await tx.query.invStockAdjustments.findFirst({
              where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adj.id)),
              with: { lines: true },
            });
            if (stored) {
              await applyAdjustmentLinesInTx(this.engine, this.glBridge, tx, orgId, userId, stored, `${idempotencyKey}:post`);
            }
          } else {
            // G3. An adjustment that stops at PENDING_APPROVAL is waiting on a
            // person, and until now nothing told that person. Emitted inside the
            // same transaction that created it, so the adjustment and the signal
            // commit together — and so the adjustment still commits when nothing
            // is listening, because the outbox row simply waits for the relay.
            await OutboxWriter.emit(tx, {
              eventId: randomUUID(),
              organizationId: orgId,
              aggregateType: "inv_stock_adjustment",
              aggregateId: String(adj.id),
              aggregateVersion: 1,
              eventType: "inventory.adjustment.approval_requested",
              payload: {
                adjustmentId: adj.id,
                referenceNumber: adj.refNum,
                reason: data.reason,
                lineCount: data.lines.length,
                requestedByUserId: userId,
              },
              occurredAt: new Date(),
            });
          }

          return adj.id;
        },
        // The stored id has been through jsonb and may come back as a string,
        // so it is parsed rather than cast; a garbled row fails loudly here
        // instead of becoming a NaN lookup that finds nothing.
        (stored) => {
          const id = revivedId(stored);
          if (!Number.isInteger(id))
            throw new ConflictException("The stored result for this key is unreadable");
          return id;
        },
      );
    });

    if (!needsApproval) await this.engine.invalidateCaches(orgId);

    return this.getAdjustment(orgId, adjustmentId, userId);
  }

  /**
   * A3. Approving is safe to repeat — the UPDATE is conditional on
   * PENDING_APPROVAL and the affected-row count is checked — but a retry after a
   * timeout got a 409 saying the adjustment was no longer pending, when the
   * caller's own earlier request is what approved it. That is the same shape as
   * a repeated confirm or dispatch, and the key exists to replay the answer
   * rather than to make the write safe.
   */
  async approveAdjustment(
    orgId: string,
    userId: string,
    adjustmentId: number,
    idempotencyKey: string,
  ) {
    await this.requireAdjustment(orgId, userId, adjustmentId);
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
    });
    if (!adj) throw new NotFoundException("Adjustment not found");

    // Writing off stock is how theft is concealed, so the person who raised the
    // adjustment may never be the person who approves it. Same maker-checker rule
    // payroll enforces on run approval.
    if (adj.createdBy === userId) {
      throw new ForbiddenException(
        "Maker-checker violation: the person who raised an adjustment cannot approve it",
      );
    }

    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.adjustments.approve", adjustmentId },
        async () => {
          // T04. This check used to sit in front of `runIdempotent`, where approve's
          // own effect invalidated it: the first call sets APPROVED and the retry was
          // refused on that status without reaching the guard that would have replayed
          // the answer. At HTTP the controller's `@Idempotent` fence hid that, but a
          // service-level caller had no such cover. Read through `tx` so the check sees
          // the same snapshot the write does.
          const [current] = await tx.select({ status: invStockAdjustments.status })
            .from(invStockAdjustments)
            .where(and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)))
            .limit(1);
          if (!current) throw new NotFoundException("Adjustment not found");
          if (current.status !== "PENDING_APPROVAL")
            throw new BadRequestException("Only PENDING_APPROVAL adjustments can be approved");

          const updated = await tx.update(invStockAdjustments)
            .set({ status: "APPROVED", approvedBy: userId, approvedAt: new Date() })
            .where(and(
              eq(invStockAdjustments.orgId, orgId),
              eq(invStockAdjustments.id, adjustmentId),
              eq(invStockAdjustments.status, "PENDING_APPROVAL"),
            ))
            .returning({ id: invStockAdjustments.id });
          if (updated.length === 0)
            throw new ConflictException("Adjustment is no longer pending approval");
          return adjustmentId;
        },
        revivedId,
      ),
    );

    return this.getAdjustment(orgId, adjustmentId, userId);
  }

  async postAdjustment(orgId: string, userId: string, adjustmentId: number, idempotencyKey: string) {
    await this.requireAdjustment(orgId, userId, adjustmentId);
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
      with: { lines: true },
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    // D8. "Unapproved cannot post" is this line, and PENDING_APPROVAL is the
    // status `createAdjustment` gives a document over either threshold — so a
    // write-off that needs a second signature has no route to the ledger until
    // `approveAdjustment` has been through maker-checker.
    if (adj.status !== "APPROVED" && adj.status !== "PENDING_POST") {
      throw new BadRequestException("Adjustment must be APPROVED or PENDING_POST to post");
    }

    await this.applyAdjustmentLines(orgId, userId, adj, idempotencyKey);
    return this.getAdjustment(orgId, adjustmentId, userId);
  }

  async cancelAdjustment(orgId: string, userId: string, adjustmentId: number) {
    await this.requireAdjustment(orgId, userId, adjustmentId);
    const adj = await this.db.query.invStockAdjustments.findFirst({
      where: and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)),
      columns: { id: true, status: true },
    });
    if (!adj) throw new NotFoundException("Adjustment not found");
    if (adj.status === "POSTED") throw new BadRequestException("Posted adjustments cannot be cancelled");

    await this.db.update(invStockAdjustments)
      .set({ status: "CANCELLED" })
      .where(and(eq(invStockAdjustments.orgId, orgId), eq(invStockAdjustments.id, adjustmentId)));

    await Promise.all([
      this.cache.invalidate(CACHE_KEYS.invStockSummary(orgId)),
    ]);
  }

  // B1-05/B1-11: engine.executeInTx + status transition to POSTED in one transaction.
  // A crash can no longer leave stock moved with the record still at PENDING_POST.
  // Both cache invalidations run in parallel after the tx commits (B1-11).
  private async applyAdjustmentLines(
    orgId: string,
    userId: string,
    adj: PostableAdjustment,
    idempotencyKey: string,
  ) {
    await this.db.transaction((tx: Tx) =>
      applyAdjustmentLinesInTx(this.engine, this.glBridge, tx, orgId, userId, adj, idempotencyKey),
    );

    await Promise.all([
      this.engine.invalidateCaches(orgId),
    ]);
  }

}
