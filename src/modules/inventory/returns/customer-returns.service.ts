import { Inject, Injectable, BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { invCustomerReturns, invCustomerReturnLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import { returnInScope } from "./lib/customer-return-scope";
import {
  createCustomerReturn,
  type ReturnCreateDeps,
} from "./lib/customer-return-create";
import {
  assertEveryLineInspected,
  assertReturnableInTx,
  postReturnInTx,
  type ReturnPostDeps,
} from "./lib/customer-return-post";
import type {
  ListReturnsInput,
  CreateCustomerReturnInput,
  PostCustomerReturnInput,
  InspectReturnLineInput,
  ApproveReturnInput,
} from "./dto/inv-returns.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
        returnInScope(orgId, scope),
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
        returnInScope(orgId, scope),
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
    return this.loadCustomerReturn(orgId, returnId, returnInScope(orgId, scope));
  }

  /**
   * The same read without the warehouse gate.
   *
   * For the paths handing back a row the caller has just written or has already
   * been gated for: `create`, and the tails of `approve`, `post` and `cancel`,
   * each of which has run the gate above.
   *
   * `create`'s claim on it is narrower than it was. It used to cover a return
   * anchored to somebody else's order or shipment, which matched no predicate
   * and so 404ed its own author; `assertSourceInScope` refuses that outright
   * now. What is left is the walk-in return, citing neither document — anchored
   * to no warehouse, therefore invisible to every scoped operator including the
   * one who just raised it. That is the list's rule working as written, and it
   * is still not a reason to hide a row from the person who wrote it.
   *
   * Named and private rather than a boolean on `get`, so a future route cannot
   * be pointed at the ungated read by accident; the shape `loadAsnUnscoped`
   * established.
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

  /** @see lib/customer-return-create.ts */
  async create(orgId: string, userId: string, data: CreateCustomerReturnInput) {
    return createCustomerReturn(this.returnDeps, orgId, userId, data);
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
          returnInScope(orgId, scope),
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
      await assertReturnableInTx(
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

  /** @see lib/customer-return-post.ts */
  private async postInTx(
    tx: Tx,
    orgId: string,
    returnId: number,
    userId: string,
    idempotencyKey: string,
    data: PostCustomerReturnInput,
  ): Promise<number> {
    return postReturnInTx(this.returnDeps, tx, orgId, returnId, userId, idempotencyKey, data);
  }

  /**
   * Built explicitly rather than passing `this`: TypeScript will not
   * structurally match a class carrying `private` members to an interface.
   * `reloadUnscopedReturn` is what keeps the ungated read on the service —
   * see the note in `lib/customer-return-create.ts`.
   */
  private get returnDeps(): ReturnCreateDeps & ReturnPostDeps {
    return {
      db: this.db,
      cache: this.cache,
      engine: this.engine,
      numSeq: this.numSeq,
      warehouseScope: this.warehouseScope,
      reloadUnscopedReturn: (orgId, returnId) => this.loadCustomerReturnUnscoped(orgId, returnId),
    };
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
        returnInScope(orgId, scope),
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

