import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  invCustomerReturns, invCustomerReturnLines, invSerialNumbers,
  invLocations, invSalesOrders, invShipments,
} from "../../../db/schema";
import { clientPartyMap } from "../../../db/schema/party";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import type { StockMovement } from "../stock-engine/stock-engine.types";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import {
  movementsForDisposition,
  serialStatusForDisposition,
  type ReturnSerialStatus,
} from "./return-dispositions";
import { assertCustomerReturnWithinShipped } from "./returnable-quantity";
import type {
  ListReturnsInput,
  CreateCustomerReturnInput,
  PostCustomerReturnInput,
  InspectReturnLineInput,
  ApproveReturnInput,
} from "./dto/inv-returns.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReturnLineRow = typeof invCustomerReturnLines.$inferSelect;

@Injectable()
export class CustomerReturnsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * Which returns this caller may see — the list's rule, now the only copy.
   *
   * A return carries no warehouse of its own. It is attributable through
   * whichever source document it came back against — the order or the shipment
   * — and a return with neither belongs to no warehouse.
   *
   * The NULL rule falls out of that and is worth stating, because it differs by
   * table on purpose. A NULL `so_id` makes `NULL IN (…)` NULL, likewise a NULL
   * `shipment_id`, and `NULL OR NULL` is NULL, so a return anchored to neither
   * document is **excluded** from a scoped caller's view. That is the opposite
   * of the ASN detail, where an unattributed row stays visible to everyone: an
   * ASN header names its warehouse nullably because it may not be known yet,
   * whereas a return with no order and no shipment is anchored to nothing and
   * showing it to every operator in the org would be a different list from the
   * one this has always been. Each detail follows its own aggregate.
   */
  private returnInScope(orgId: string, scope: ResolvedWarehouseScope): SQL {
    return scope.anyOf(
      sql`${invCustomerReturns.soId} IN (SELECT id FROM inv_sales_orders WHERE org_id = ${orgId} AND ${scope.warehouse(sql.raw("warehouse_id"))})`,
      sql`${invCustomerReturns.shipmentId} IN (SELECT id FROM inv_shipments WHERE org_id = ${orgId} AND ${scope.warehouse(sql.raw("warehouse_id"))})`,
    );
  }

  /**
   * The gate for the mutations that lock the row themselves.
   *
   * `approve` and `post` open with a `SELECT … FOR UPDATE` in raw SQL, and
   * threading the predicate through that would put the scope inside a statement
   * whose job is locking. They ask this first instead. A miss is 404, never 403
   * (§4): a "forbidden" on a return id confirms the return exists.
   */
  private async assertReturnVisible(orgId: string, userId: string, returnId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [visible] = await this.db
      .select({ id: invCustomerReturns.id })
      .from(invCustomerReturns)
      .where(and(
        eq(invCustomerReturns.id, returnId),
        eq(invCustomerReturns.orgId, orgId),
        this.returnInScope(orgId, scope),
      ))
      .limit(1);
    if (!visible) throw new NotFoundException("Customer return not found");
  }

  async list(orgId: string, userId: string, filters: ListReturnsInput) {
    const { status, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${status ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(CACHE_KEYS.invCustomerReturnsNamespace(orgId), hash, async () => {
      const conditions = [
        eq(invCustomerReturns.orgId, orgId),
        this.returnInScope(orgId, scope),
      ];
      if (status) conditions.push(eq(invCustomerReturns.status, status));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invCustomerReturns.findMany({
          where,
          orderBy: [desc(invCustomerReturns.createdAt)],
          limit,
          offset,
          with: {
            creator: { columns: { id: true, name: true } },
            client: { columns: { id: true, name: true } },
            lines: true,
          },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invCustomerReturns).where(where),
      ]);

      return {
        items,
        total: countResult[0]?.count ?? 0,
        page,
        totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
      };
    }, CACHE_TTL.SHORT);
  }

  /**
   * One return, read by id — and, until now, by anyone in the org.
   *
   * `list` beside it resolves the caller's warehouses; this took no `userId`,
   * because the controller never passed one, so it answered on `org_id` and the
   * return id. It also returns more than the list does: the client, the creator,
   * the approver and every line, which is the customer and the goods.
   */
  async get(orgId: string, userId: string, returnId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.loadCustomerReturn(orgId, returnId, this.returnInScope(orgId, scope));
  }

  /**
   * The same read without the warehouse gate.
   *
   * For the paths handing back a row the caller has just written or has already
   * been gated for: `create`, where gating would 404 an operator against the
   * return they just raised — a return whose order and shipment sit outside
   * their warehouses matches no predicate at all — and the tails of `approve`,
   * `post` and `cancel`, each of which has run the gate above. Named and
   * private rather than a boolean on `get`, so a future route cannot be pointed
   * at the ungated read by accident; the shape `loadAsnUnscoped` established.
   */
  private loadCustomerReturnUnscoped(orgId: string, returnId: number) {
    return this.loadCustomerReturn(orgId, returnId, undefined);
  }

  private async loadCustomerReturn(orgId: string, returnId: number, inScope: SQL | undefined) {
    const ret = await this.db.query.invCustomerReturns.findFirst({
      where: and(
        eq(invCustomerReturns.id, returnId),
        eq(invCustomerReturns.orgId, orgId),
        inScope,
      ),
      with: {
        creator: { columns: { id: true, name: true } },
        approver: { columns: { id: true, name: true } },
        client: { columns: { id: true, name: true } },
        lines: true,
      },
    });
    if (!ret) throw new NotFoundException("Customer return not found");
    return ret;
  }

  async create(orgId: string, userId: string, data: CreateCustomerReturnInput) {
    if (data.soId !== undefined && data.soId !== null) {
      const so = await this.db.query.invSalesOrders.findFirst({
        where: and(eq(invSalesOrders.id, data.soId), eq(invSalesOrders.orgId, orgId)),
        columns: { id: true },
      });
      if (!so) throw new BadRequestException("Sales order not found in this organization");
    }

    if (data.shipmentId !== undefined && data.shipmentId !== null) {
      const shipment = await this.db.query.invShipments.findFirst({
        where: and(eq(invShipments.id, data.shipmentId), eq(invShipments.orgId, orgId)),
        columns: { id: true },
      });
      if (!shipment) throw new BadRequestException("Shipment not found in this organization");
    }

    if (data.clientId !== undefined && data.clientId !== null) {
      /*
       * Asked of `client_party_map` rather than `clients`, which answers the same
       * question through the Party seam. The map's primary key is
       * `(organization_id, client_id)` and its composite foreign key cascades from
       * `clients`, so a row exists here exactly when the client exists in this
       * tenant -- which is all this check ever wanted. `invCustomerReturns.client_id`
       * still points at `clients`, so the id kept here is still the legacy one.
       */
      const [client] = await this.db
        .select({ id: clientPartyMap.clientId })
        .from(clientPartyMap)
        .where(
          and(
            eq(clientPartyMap.clientId, data.clientId),
            eq(clientPartyMap.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!client) throw new BadRequestException("Client not found in this organization");
    }

    // B9, item 3. Refused at intake as well as at approval, so somebody typing
    // 12 against a shipment of 10 finds out now rather than after an inspection
    // walk. Return id 0 excludes nothing, which is right: this return does not
    // exist yet.
    await assertCustomerReturnWithinShipped(
      this.db,
      orgId,
      0,
      { soId: data.soId ?? null, shipmentId: data.shipmentId ?? null },
      data.lines.map((line) => ({
        productVariantId: line.productVariantId,
        lotId: line.lotId ?? null,
        serialId: line.serialId ?? null,
        quantity: line.quantity,
      })),
    );

    const returnNumber = await this.numSeq.next(orgId, "CUSTOMER_RETURN");

    const [ret] = await this.db.insert(invCustomerReturns).values({
      orgId,
      returnNumber,
      soId: data.soId,
      shipmentId: data.shipmentId,
      clientId: data.clientId,
      notes: data.notes,
      status: "DRAFT",
      createdBy: userId,
    }).returning();

    await this.db.insert(invCustomerReturnLines).values(
      data.lines.map((line) => ({
        orgId,
        returnId: ret.id,
        productVariantId: line.productVariantId,
        lotId: line.lotId,
        serialId: line.serialId,
        quantity: line.quantity,
        disposition: line.disposition,
        targetLocationId: line.targetLocationId,
        notes: line.reason,
      }))
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.invCustomerReturnsNamespace(orgId));
    return this.loadCustomerReturnUnscoped(orgId, ret.id);
  }

  /**
   * INV-209 — record the decision made after actually looking at the goods.
   *
   * This is the step the workflow was missing. A disposition asserted at
   * creation is a guess from the customer's description, and it was the guess
   * that posted stock: a "faulty, please refund" note put goods straight into
   * SCRAP without anybody confirming they were faulty, and a "wrong size" note
   * restocked goods nobody had looked at.
   *
   * The author and the time are recorded, not just the answer, so "who decided
   * this was resaleable" has an answer six months later when it turns out it
   * was not.
   */
  async inspectLine(
    orgId: string,
    userId: string,
    returnId: number,
    input: InspectReturnLineInput,
  ) {
    // The same gate the list applies. Recording a disposition is deciding what
    // happens to the goods, and it was reachable on any return in the org.
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const [ret] = await this.db
      .select({ id: invCustomerReturns.id, status: invCustomerReturns.status })
      .from(invCustomerReturns)
      .where(
        and(
          eq(invCustomerReturns.orgId, orgId),
          eq(invCustomerReturns.id, returnId),
          this.returnInScope(orgId, scope),
        ),
      );
    if (!ret) throw new NotFoundException("Customer return not found");
    // B9. DRAFT only. Inspecting a posted return would change a disposition the
    // ledger has already acted on; inspecting an approved one would change what
    // the approver signed off, silently.
    if (ret.status !== "DRAFT") {
      throw new BadRequestException(
        `A ${ret.status} return can no longer be inspected`,
      );
    }

    const [updated] = await this.db
      .update(invCustomerReturnLines)
      .set({
        disposition: input.disposition,
        inspectionNotes: input.inspectionNotes ?? null,
        inspectedAt: new Date(),
        inspectedBy: userId,
      })
      .where(
        and(
          eq(invCustomerReturnLines.orgId, orgId),
          eq(invCustomerReturnLines.returnId, returnId),
          eq(invCustomerReturnLines.id, input.lineId),
        ),
      )
      .returning({ id: invCustomerReturnLines.id });
    if (!updated) throw new NotFoundException("Return line not found");

    await this.cache.invalidateNamespace(
      CACHE_KEYS.invCustomerReturnsNamespace(orgId),
    );
    return { lineId: input.lineId, disposition: input.disposition };
  }

  /**
   * B9, item 1 — the sign-off, between the inspection and the ledger.
   *
   * DRAFT -> POSTED made agreeing to move stock and moving it the same click,
   * which left INV-209's inspection with nobody accountable for accepting it
   * and gave a cancellation exactly one moment it could happen in.
   *
   * Every gate the post applies is applied here too rather than only here: this
   * is the readable failure, and `post` re-asserts under its row lock because
   * an approval is not a lock.
   */
  async approve(
    orgId: string,
    returnId: number,
    userId: string,
    input: ApproveReturnInput,
  ) {
    await this.assertReturnVisible(orgId, userId, returnId);
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.execute<{
        status: string;
        so_id: number | null;
        shipment_id: number | null;
      }>(sql`
        SELECT status, so_id, shipment_id FROM inv_customer_returns
        WHERE id = ${returnId} AND org_id = ${orgId} FOR UPDATE`);
      if (!locked) throw new NotFoundException("Customer return not found");
      // Approving twice is the same approval, so it is not an error.
      if (locked.status === "APPROVED") return;
      if (locked.status !== "DRAFT") {
        throw new BadRequestException(
          `Only DRAFT customer returns can be approved; this one is ${locked.status}`,
        );
      }

      const lines = await tx
        .select()
        .from(invCustomerReturnLines)
        .where(
          and(
            eq(invCustomerReturnLines.orgId, orgId),
            eq(invCustomerReturnLines.returnId, returnId),
          ),
        );
      if (lines.length === 0)
        throw new BadRequestException("A customer return with no lines cannot be approved");
      assertEveryLineInspected(lines);
      await this.assertReturnableInTx(
        tx,
        orgId,
        {
          id: returnId,
          soId: locked.so_id === null ? null : Number(locked.so_id),
          shipmentId: locked.shipment_id === null ? null : Number(locked.shipment_id),
        },
        lines,
      );

      await tx
        .update(invCustomerReturns)
        .set({
          status: "APPROVED",
          approvedBy: userId,
          approvedAt: new Date(),
          // Item 5. Recorded, and that is all. Nothing downstream waits on it,
          // and the absence of one never stops the goods reaching the shelf.
          ...(input.creditReference !== undefined
            ? { creditReference: input.creditReference }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(invCustomerReturns.id, returnId),
            eq(invCustomerReturns.orgId, orgId),
            eq(invCustomerReturns.status, "DRAFT"),
          ),
        );
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invCustomerReturnsNamespace(orgId));
    return this.loadCustomerReturnUnscoped(orgId, returnId);
  }

  /**
   * Moves the stock the approval agreed to move.
   *
   * The idempotency claim spans the whole command, not the engine call. A return
   * whose every line was SCRAPPED produces no movements at all, so a claim taken
   * only around `executeInTx` would leave exactly that case unguarded — the
   * defect found on the sibling receiving path, where a fully-rejected delivery
   * claimed nothing and a retry raised a second one.
   */
  async post(
    orgId: string,
    returnId: number,
    userId: string,
    idempotencyKey: string,
    data: PostCustomerReturnInput,
  ) {
    await this.assertReturnVisible(orgId, userId, returnId);
    const posted = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.customer-return.post", returnId, reason: data.reason ?? null },
        () => this.postInTx(tx, orgId, returnId, userId, idempotencyKey, data),
        (stored) => {
          const id = revivedId(stored);
          if (!Number.isInteger(id))
            throw new ConflictException("The stored result for this key is unreadable");
          return id;
        },
      ),
    );

    await this.engine.invalidateCaches(orgId);
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.invCustomerReturnsNamespace(orgId)),
      this.cache.del(CACHE_KEYS.invCustomerReturnDetail(orgId, returnId)),
    ]);
    return this.loadCustomerReturnUnscoped(orgId, posted);
  }

  private async postInTx(
    tx: Tx,
    orgId: string,
    returnId: number,
    userId: string,
    idempotencyKey: string,
    data: PostCustomerReturnInput,
  ): Promise<number> {
    // The row lock before anything is read. Two posts under different keys
    // otherwise both see APPROVED and both move stock.
    const [locked] = await tx.execute<{ status: string }>(sql`
      SELECT status FROM inv_customer_returns
      WHERE id = ${returnId} AND org_id = ${orgId} FOR UPDATE`);
    if (!locked) throw new NotFoundException("Customer return not found");
    // Already posted under some other key. The ledger is append-only and the
    // goods are already on the shelf, so the only correct answer is to change
    // nothing.
    if (locked.status === "POSTED") return returnId;
    if (locked.status !== "APPROVED") {
      throw new BadRequestException(
        locked.status === "DRAFT"
          ? "This customer return must be approved before it can be posted"
          : `A ${locked.status} customer return cannot be posted`,
      );
    }

    const ret = await tx.query.invCustomerReturns.findFirst({
      where: and(eq(invCustomerReturns.id, returnId), eq(invCustomerReturns.orgId, orgId)),
      with: { lines: true },
    });
    if (!ret) throw new NotFoundException("Customer return not found");

    // INV-209. Re-asserted under the lock rather than trusted from the
    // approval: posting is what moves stock, so posting is what has to be sure.
    assertEveryLineInspected(ret.lines);
    await this.assertReturnableInTx(tx, orgId, ret, ret.lines);

    const engineMovements: StockMovement[] = [];
    for (const line of ret.lines) {
      const targetLocationId = await this.resolveTargetLocation(tx, orgId, line);
      engineMovements.push(...movementsForDisposition(
        {
          productVariantId: line.productVariantId,
          disposition: line.disposition,
          quantity: line.quantity,
          lotId: line.lotId,
          serialId: line.serialId,
        },
        targetLocationId,
      ));
    }

    const byStatus = new Map<ReturnSerialStatus, number[]>();
    for (const line of ret.lines) {
      if (line.serialId === null) continue;
      const serialStatus = serialStatusForDisposition(line.disposition);
      const ids = byStatus.get(serialStatus) ?? [];
      ids.push(line.serialId);
      byStatus.set(serialStatus, ids);
    }

    if (engineMovements.length > 0) {
      await this.engine.executeInTx(tx, orgId, userId, {
        // Derived rather than shared: the command's own key is already claimed
        // by `runIdempotent` above, and handing the engine the same string
        // would make it collide with that live claim.
        idempotencyKey: `${idempotencyKey}:stock`,
        sourceType: "inv_customer_return",
        sourceId: String(returnId),
        reason: data.reason,
        movements: engineMovements,
      });
    }

    for (const [serialStatus, ids] of byStatus) {
      await tx.update(invSerialNumbers)
        .set({ status: serialStatus })
        .where(inArray(invSerialNumbers.id, ids));
    }

    await tx.update(invCustomerReturns)
      .set({ status: "POSTED", postedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(invCustomerReturns.id, returnId),
        eq(invCustomerReturns.orgId, orgId),
        eq(invCustomerReturns.status, "APPROVED"),
      ));

    await emitInventoryCommandEvent(tx, {
      orgId,
      eventType: INVENTORY_COMMAND_EVENTS.RETURN_POSTED,
      aggregateType: "inv_customer_return",
      aggregateId: String(returnId),
      actorUserId: userId,
      payload: {
        // One event type for both directions, because "goods came back" is
        // one thing a consumer subscribes to; which way they went is a
        // field, not a separate contract.
        returnType: "CUSTOMER",
        returnId,
        returnNumber: ret.returnNumber,
        soId: ret.soId,
        shipmentId: ret.shipmentId,
        clientId: ret.clientId,
        lineCount: ret.lines.length,
        // What was decided about the goods. A restock and a scrap are the
        // same document and opposite outcomes, and a consumer that has to
        // re-read the lines to tell them apart has been told nothing.
        dispositions: ret.lines.map((line) => ({
          lineId: line.id,
          productVariantId: line.productVariantId,
          disposition: line.disposition,
        })),
        // Item 5. The pointer, carried so an accounting adapter can reconcile
        // the credit against the goods without asking us for it.
        creditReference: ret.creditReference,
        approvedBy: ret.approvedBy,
        reason: data.reason ?? null,
        idempotencyKey,
      },
    });

    return returnId;
  }

  private assertReturnableInTx(
    tx: Tx,
    orgId: string,
    ret: { id: number; soId: number | null; shipmentId: number | null },
    lines: ReturnLineRow[],
  ): Promise<void> {
    return assertCustomerReturnWithinShipped(
      tx,
      orgId,
      ret.id,
      { soId: ret.soId, shipmentId: ret.shipmentId },
      lines,
    );
  }

  /**
   * Where these goods land.
   *
   * The line's own choice wins. Failing that the disposition decides the kind of
   * place: quarantined goods want a QUARANTINE bin, everything kept wants a
   * RETURNS bin. The final fallback excludes locations flagged unsellable —
   * every warehouse has a `TRANSIT` location and it is `is_sellable = false`, so
   * restocking into one would raise on-hand while availability stayed flat and
   * the goods would read as lost.
   */
  private async resolveTargetLocation(
    tx: Tx,
    orgId: string,
    line: Pick<ReturnLineRow, "disposition" | "targetLocationId">,
  ): Promise<number> {
    if (line.targetLocationId) return line.targetLocationId;

    type LocationType = typeof invLocations.$inferSelect["locationType"];
    const locationType: LocationType = line.disposition === "QUARANTINE" ? "QUARANTINE" : "RETURNS";
    const loc = await tx.query.invLocations.findFirst({
      where: and(
        eq(invLocations.orgId, orgId),
        eq(invLocations.locationType, locationType),
        eq(invLocations.isActive, true),
      ),
      columns: { id: true },
    });

    if (loc) return loc.id;

    const [anyLoc] = await tx.execute<{ id: number }>(sql`
      SELECT id FROM inv_locations
      WHERE org_id = ${orgId} AND is_active = true AND is_sellable IS NOT FALSE
      ORDER BY id ASC LIMIT 1`);

    if (!anyLoc) throw new BadRequestException("No active location found for customer return");
    return Number(anyLoc.id);
  }

  /**
   * B9. Cancellable from DRAFT and from APPROVED — an approval is reversible
   * until it posts.
   *
   * The sharpest thing in this file, and it took no caller identity at all: the
   * controller had `@CurrentUser()` in hand and passed only `orgId`, so anybody
   * with the permission could cancel any return in the organisation by id,
   * including one approved in a warehouse they have never worked in. It reads
   * under the list's own predicate now, and a miss is 404 rather than 403 so the
   * refusal does not confirm the return exists.
   */
  async cancel(orgId: string, userId: string, returnId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const ret = await this.db.query.invCustomerReturns.findFirst({
      where: and(
        eq(invCustomerReturns.id, returnId),
        eq(invCustomerReturns.orgId, orgId),
        this.returnInScope(orgId, scope),
      ),
    });
    if (!ret) throw new NotFoundException("Customer return not found");
    if (ret.status !== "DRAFT" && ret.status !== "APPROVED")
      throw new BadRequestException(`A ${ret.status} customer return cannot be cancelled`);

    await this.db.update(invCustomerReturns)
      .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(invCustomerReturns.id, returnId),
        eq(invCustomerReturns.orgId, orgId),
        inArray(invCustomerReturns.status, ["DRAFT", "APPROVED"]),
      ));

    await this.cache.invalidateNamespace(CACHE_KEYS.invCustomerReturnsNamespace(orgId));
    return this.loadCustomerReturnUnscoped(orgId, returnId);
  }
}

/**
 * INV-209. Posting moves stock, so every line must have been *looked at* first
 * — `inspectedAt`, not merely `disposition`.
 *
 * Gating on the disposition was the weaker test and it defeated the ticket: a
 * disposition declared at intake is a guess from the customer's description,
 * which is exactly the thing that was posting stock without anybody opening the
 * box. It is still accepted at create as a statement of intent; it just no
 * longer counts as an inspection.
 *
 * Reported together rather than one at a time: somebody clearing a twelve-line
 * return should not discover the gaps twelve attempts later.
 */
function assertEveryLineInspected(lines: ReturnLineRow[]): void {
  const uninspected = lines.filter((line) => line.inspectedAt === null);
  if (uninspected.length > 0) {
    throw new BadRequestException(
      `These lines have not been inspected yet: ${uninspected.map((l) => l.id).join(", ")}`,
    );
  }
}
