import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { invSalesOrders, businessParties } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { InvNearExpiryPolicy } from "../stock-engine/stock-engine.types";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { SoLifecycleService } from "./so-lifecycle.service";
import type {
  CreateSoInput,
  ListSoInput,
  UpdateSoInput,
} from "./dto/inv-sales-orders.schemas";
import { getAtp } from "./lib/atp";
import { soInScope } from "./lib/so-scope";
import {
  createSalesOrder,
  updateSalesOrder,
  type SoWriteDeps,
} from "./lib/so-write";

@Injectable()
export class SoCoreService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly lifecycle: SoLifecycleService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  private get soWriteDeps(): SoWriteDeps {
    return {
      db: this.db,
      cache: this.cache,
      numSeq: this.numSeq,
      warehouseScope: this.warehouseScope,
    };
  }

  async listSos(
    orgId: string,
    filters: ListSoInput,
    scope: DataScope = "all",
    userId?: string,
  ) {
    if (scope === "none") return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, clientId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
    const warehouses = userId ? await this.warehouseScope.forUser(orgId, userId) : null;
    const hash = `${warehouses?.key ?? "all"}:${status ?? ""}:${clientId ?? ""}:${limit}:${offset}${scopeSuffix}`;

    return this.cache.cachedVersioned(
      CACHE_KEYS.invSoNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invSalesOrders.orgId, orgId)];
        if (warehouses) conditions.push(soInScope(warehouses));
        if (status) conditions.push(eq(invSalesOrders.status, status));
        if (clientId) conditions.push(eq(invSalesOrders.clientId, clientId));
        if (scope !== "all" && userId) {
          conditions.push(
            applyScope(scope, orgId, userId, {
              ownerColumn: invSalesOrders.createdBy,
            }),
          );
        }
        const where = and(...conditions);

        const [items, countResult] = await Promise.all([
          this.db.query.invSalesOrders.findMany({
            where,
            orderBy: [desc(invSalesOrders.createdAt)],
            limit,
            offset,
            with: {
              client: { columns: { id: true, name: true } },
              creator: { columns: { id: true, name: true } },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invSalesOrders)
            .where(where),
        ]);

        return {
          items,
          total: countResult[0]?.count ?? 0,
          page,
          totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  /**
   * A sales order with everything the detail screen shows.
   *
   * The customer is resolved through Party, not by joining `clients`. That table
   * was dropped by the identity migration during this work, so the eager join
   * here failed outright with `42P01 relation "clients" does not exist` — every
   * read of a sales order, including the one the fulfilment flow makes after
   * shipping. `inv_sales_orders.client_party_id` is the Party-era column and
   * carries the same customer.
   */
  async getSo(orgId: string, userId: string, soId: number) {
    /*
     * `listSos` beside this has narrowed on the caller's warehouses since the
     * warehouse work landed; this took no `userId` at all, because the
     * controller had `@CurrentUser()` in hand and passed only `orgId`. So an
     * order an operator could not see in their list was theirs to read whole:
     * the customer, the shipping address, every line with its price, and the
     * invoice hanging off it.
     *
     * Nothing downstream would have caught it — a read posts no movements, so
     * the engine's `assertLocationsInScope` never runs on this path.
     *
     * The `/:soId/atp` route reads through here first and spends the lines it
     * gets on `getAtp`, so gating this gates that too: availability stays the
     * org-wide number a promise is actually made against, but you can only ask
     * it about an order you may see.
     *
     * Not cached. `CACHE_KEYS.invSoDetail` exists and five services bust it, but
     * nothing has ever read it — so there is no key here to carry a scope
     * discriminator. If one is ever added it must carry `scope.key`, or a
     * correct predicate under a scope-free key would store one caller's narrowed
     * answer and serve it to the next, which is worse than the unscoped read
     * this replaces (§6).
     */
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(
        eq(invSalesOrders.id, soId),
        eq(invSalesOrders.orgId, orgId),
        soInScope(scope),
      ),
      with: {
        warehouse: true,
        invoice: true,
        creator: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: {
              with: { product: { columns: { id: true, name: true, sku: true } } },
            },
          },
        },
      },
    });
    if (!so) throw new NotFoundException("Sales order not found");
    return { ...so, client: await this.resolveCustomer(orgId, so.clientPartyId) };
  }

  /** Display identity only; anything sensitive stays behind its own gate. */
  private async resolveCustomer(orgId: string, partyId: string | null) {
    if (!partyId) return null;
    const [party] = await this.db
      .select({
        partyId: businessParties.partyId,
        displayName: businessParties.displayName,
        companyName: businessParties.companyName,
      })
      .from(businessParties)
      .where(and(eq(businessParties.organizationId, orgId), eq(businessParties.partyId, partyId)))
      .limit(1);
    return party ?? null;
  }

  /** @see lib/so-write.ts — the body moved, the service surface did not. */
  async createSo(orgId: string, userId: string, data: CreateSoInput) {
    return createSalesOrder(this.soWriteDeps, orgId, userId, data);
  }

  /**
   * @see lib/so-write.ts — the write moved; the re-read deliberately did not.
   *
   * `getSo` is the module's one scoped detail read, and an edit answering with a
   * row assembled anywhere else is how the two drift apart.
   */
  async updateSo(orgId: string, soId: number, userId: string, data: UpdateSoInput) {
    await updateSalesOrder(this.soWriteDeps, orgId, soId, userId, data);
    return this.getSo(orgId, userId, soId);
  }

  /** @see lib/atp.ts — the body moved, the service surface did not. */
  async getAtp(orgId: string, productVariantIds: number[]) {
    return getAtp(this.db, orgId, productVariantIds);
  }

  confirmSo(orgId: string, soId: number, userId: string, idempotencyKey: string) {
    return this.lifecycle.confirmSo(orgId, soId, userId, idempotencyKey);
  }

  cancelSo(orgId: string, soId: number, userId: string) {
    return this.lifecycle.cancelSo(orgId, soId, userId);
  }

  invoiceSo(orgId: string, soId: number, userId: string) {
    return this.lifecycle.invoiceSo(orgId, soId, userId);
  }

  findAvailableLotForLine(
    orgId: string,
    variantId: number,
    warehouseId: number | null | undefined,
    /** Base UOM, as a decimal string — never a float. */
    qty: string,
    strategy: string,
    expiryPolicy: string,
    /**
     * D2. Forwarded rather than dropped. This delegation used to stop at
     * `expiryPolicy`, so every caller reaching the allocator through here — the
     * reserve button, pick waves, pick substitution — allocated with no
     * near-expiry tier and no customer shelf-life floor, whatever the
     * organisation and the contract said. A parameter silently not forwarded is
     * the same defect as a rule not written.
     */
    constraints?: {
      nearExpiryPolicy: InvNearExpiryPolicy;
      nearExpiryWindowDays: number;
      minShelfLifeDays: number;
    },
  ) {
    return this.lifecycle.findAvailableLotForLine(
      orgId,
      variantId,
      warehouseId,
      qty,
      strategy,
      expiryPolicy,
      constraints,
    );
  }
}
