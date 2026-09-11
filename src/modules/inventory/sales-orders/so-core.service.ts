import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { partyNamesFor } from "../../party/party-names";
import { ScopedRead } from "../../access/scoped-read";
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

  async listSos(read: ScopedRead, filters: ListSoInput) {
    const orgId = read.orgId;
    const { status, clientId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const warehouses = await this.warehouseScope.forUser(orgId, read.actorId);
    const hash = `${warehouses?.key ?? "all"}:${status ?? ""}:${clientId ?? ""}:${limit}:${offset}:${read.discriminator}`;

    return this.cache.cachedVersioned(
      CACHE_KEYS.invSoNamespace(orgId),
      hash,
      () =>
        read.read(
          {
            tenant: invSalesOrders.orgId,
            scope: { columns: { ownerColumn: invSalesOrders.createdBy } },
            and: [
              warehouses ? soInScope(warehouses) : undefined,
              status ? eq(invSalesOrders.status, status) : undefined,
              clientId ? eq(invSalesOrders.clientId, clientId) : undefined,
            ],
          },
          async ({ sql: where }) => {
            const [items, countResult] = await Promise.all([
              this.db.query.invSalesOrders.findMany({
                where,
                orderBy: [desc(invSalesOrders.createdAt)],
                limit,
                offset,
                with: {
                  creator: { columns: { id: true, name: true } },
                },
              }),
              this.db
                .select({ count: sql<number>`count(*)::int` })
                .from(invSalesOrders)
                .where(where),
            ]);

            /**
             * The client's name from Party, not from `clients`. Ticket 08.
             *
             * `client_id` is still what the order is filed under and is still
             * returned as `client.id`; only the name moved.
             */
            const names = await partyNamesFor(this.db, orgId, items.map((o) => o.clientPartyId));
            const withClient = items.map((order) => ({
              ...order,
              client: order.clientId
                ? {
                    id: order.clientId,
                    name: order.clientPartyId ? (names.get(order.clientPartyId) ?? null) : null,
                  }
                : null,
            }));

            return {
              items: withClient,
              total: countResult[0]?.count ?? 0,
              page,
              totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
            };
          },
          () => ({ items: [], total: 0, page, totalPages: 0 }),
        ),
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
    return { ...so, client: await this.resolveCustomer(orgId, so.clientId, so.clientPartyId) };
  }

  /**
   * The customer, from Party — never from `clients`, which is gone.
   *
   * Display identity only; anything sensitive stays behind its own gate.
   *
   * One shape for both readers of this field. Ticket 08 kept the shape
   * `client: true` used to return — `client.id` is still the legacy id the
   * order was filed under, and `client.name` is what the sales-order screen
   * reads as the customer. The inventory lane's Party-era fields sit beside
   * them: `partyId`, `displayName`, `companyName`.
   *
   * Null only when the order names no customer at all. An order with a legacy
   * id and no party yet still says which client it was filed under; a
   * Party-era order with no legacy id still names its customer.
   *
   * The organisation predicate is the part that must not drift: a name lookup
   * that forgets it is a cross-tenant read that returns something plausible.
   */
  private async resolveCustomer(orgId: string, clientId: number | null, partyId: string | null) {
    if (clientId === null && !partyId) return null;
    const [party] = partyId
      ? await this.db
          .select({
            partyId: businessParties.partyId,
            name: businessParties.name,
            displayName: businessParties.displayName,
            companyName: businessParties.companyName,
            status: businessParties.status,
            email: businessParties.email,
            phone: businessParties.phone,
          })
          .from(businessParties)
          .where(and(eq(businessParties.organizationId, orgId), eq(businessParties.partyId, partyId)))
          .limit(1)
      : [];
    return {
      id: clientId,
      partyId: party?.partyId ?? partyId,
      name: party?.name ?? null,
      displayName: party?.displayName ?? null,
      companyName: party?.companyName ?? null,
      status: party?.status ?? null,
      email: party?.email ?? null,
      phone: party?.phone ?? null,
    };
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
