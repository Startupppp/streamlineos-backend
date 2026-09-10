import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  invAsnLines,
  invAsns,
  invPlatformPoLines,
  invPlatformPurchaseOrders,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { ChannelPoolService } from "../../stock-engine/channel-pool.service";
import {
  WarehouseScopeService,
  type ResolvedWarehouseScope,
} from "../../stock-engine/warehouse-scope.service";
import { DockService } from "../../dock/dock.service";
import {
  BlinkitInboundAdapter,
  InstamartInboundAdapter,
  ZeptoEmailInboundAdapter,
  type QuickCommerceInboundAdapter,
  type QuickCommerceProvider,
} from "./quick-commerce-inbound";
import { ingestPurchaseOrder, type QcIngestDeps } from "./lib/quick-commerce-ingest";
import { acceptPurchaseOrder, type QcAcceptDeps } from "./lib/quick-commerce-accept";
import {
  assertReceivable,
  createAsn,
  type QcAsnDeps,
} from "./lib/quick-commerce-asn";
import type {
  AcceptPlatformPoInput,
  CreateAsnInput,
  IngestPlatformPoInput,
  ListPlatformPosQuery,
} from "./dto/quick-commerce.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class QuickCommerceInboundService {
  private readonly adapters: ReadonlyMap<QuickCommerceProvider, QuickCommerceInboundAdapter> = new Map<
    QuickCommerceProvider,
    QuickCommerceInboundAdapter
  >([
    ["BLINKIT", new BlinkitInboundAdapter()],
    ["INSTAMART", new InstamartInboundAdapter()],
    ["ZEPTO", new ZeptoEmailInboundAdapter()],
  ]);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: InventorySettingsService,
    private readonly audit: InventoryAuditService,
    private readonly numSeq: NumberSequenceService,
    private readonly channelPools: ChannelPoolService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly dock: DockService,
  ) {}

  /** @see lib/quick-commerce-ingest.ts */
  async ingestPurchaseOrder(
    orgId: string,
    userId: string,
    input: IngestPlatformPoInput,
    idempotencyKey: string,
  ) {
    return ingestPurchaseOrder(this.qcDeps, orgId, userId, input, idempotencyKey);
  }

  /**
   * Which platform purchase orders this caller may see.
   *
   * The ASN's rule, deliberately, and not the shipment's. A platform PO keeps an
   * `IS NULL` escape because its warehouse may genuinely not be chosen yet:
   * `ingestPurchaseOrder` says so in as many words — a document can arrive
   * before anybody has wired the channel up, and refusing it then would lose the
   * document rather than the configuration gap. An unattributed platform PO is
   * precisely the one somebody has to open in order to give it a building, so
   * hiding it from every scoped operator would strand it.
   *
   * The three cases are exactly `listAsns`': unrestricted sees everything, a
   * caller holding no warehouse at all sees nothing (not even the unattributed
   * ones — no assignment means no site), and a scoped caller sees their own
   * buildings plus the not-yet-assigned. That is the opposite of the shipments
   * and sales-order rule, where `NULL IN (…)` is NULL and an unattributed row
   * stays hidden; each surface follows its own aggregate.
   */
  private platformPoInScope(scope: ResolvedWarehouseScope): SQL {
    if (scope.unrestricted) return sql`TRUE`;
    if (scope.isEmpty) return sql`FALSE`;
    return sql`(${invPlatformPurchaseOrders.warehouseId} IS NULL OR ${scope.warehouse(
      sql`${invPlatformPurchaseOrders.warehouseId}`,
    )})`;
  }

  /**
   * Every platform purchase order in the organisation, until now.
   *
   * This is not the ordinary "the list was scoped and the detail was not": NEITHER
   * was, and the pair is the only reachable surface in this service that never
   * asked. `ingestPurchaseOrder`, `acceptPurchaseOrder` and `createAsn` each
   * assert the warehouse they write into, `listAsns` and `asnDetail` both narrow,
   * and `FillRateService.report` asserts a platform PO's warehouse before it will
   * report on one — so the rule was already settled by every sibling. These two
   * simply took no `userId`, though the controller had `@CurrentUser()` in hand
   * for both.
   *
   * Nothing downstream would have caught it: reading a platform PO posts no
   * movements, so the engine's `assertLocationsInScope` never runs here.
   */
  async list(orgId: string, userId: string, query: ListPlatformPosQuery) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const conditions = [eq(invPlatformPurchaseOrders.orgId, orgId), this.platformPoInScope(scope)];
    if (query.provider) conditions.push(eq(invPlatformPurchaseOrders.provider, query.provider));
    if (query.status) conditions.push(eq(invPlatformPurchaseOrders.status, query.status));

    return this.db
      .select({
        id: invPlatformPurchaseOrders.id,
        provider: invPlatformPurchaseOrders.provider,
        providerPoNumber: invPlatformPurchaseOrders.providerPoNumber,
        status: invPlatformPurchaseOrders.status,
        destinationRef: invPlatformPurchaseOrders.destinationRef,
        expectedDeliveryDate: invPlatformPurchaseOrders.expectedDeliveryDate,
        poId: invPlatformPurchaseOrders.poId,
        rejectionReason: invPlatformPurchaseOrders.rejectionReason,
        createdAt: invPlatformPurchaseOrders.createdAt,
      })
      .from(invPlatformPurchaseOrders)
      .where(and(...conditions))
      .orderBy(desc(invPlatformPurchaseOrders.createdAt), desc(invPlatformPurchaseOrders.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
  }

  async detail(orgId: string, userId: string, platformPoId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.loadPlatformPo(orgId, platformPoId, this.platformPoInScope(scope));
  }

  /**
   * The unscoped read, named so nobody routes to it by accident.
   *
   * `ingestPurchaseOrder`, `acceptPurchaseOrder` and `createAsn` all end by
   * returning the document they have just acted on, and every one of them has
   * ALREADY asserted the warehouse it wrote — so the caller's standing is
   * settled before this runs, and gating it again would refuse an operator the
   * platform order they have this instant accepted.
   */
  private async detailUnscoped(orgId: string, platformPoId: number) {
    return this.loadPlatformPo(orgId, platformPoId, null);
  }

  private async loadPlatformPo(orgId: string, platformPoId: number, gate: SQL | null) {
    const [header] = await this.db
      .select()
      .from(invPlatformPurchaseOrders)
      .where(
        gate === null
          ? and(
              eq(invPlatformPurchaseOrders.orgId, orgId),
              eq(invPlatformPurchaseOrders.id, platformPoId),
            )
          : and(
              eq(invPlatformPurchaseOrders.orgId, orgId),
              eq(invPlatformPurchaseOrders.id, platformPoId),
              gate,
            ),
      );
    // 404 rather than 403: a "forbidden" on a platform purchase-order id
    // confirms it exists, which turns a probe into an existence oracle (§4).
    if (!header) throw new NotFoundException("Not found");

    const lines = await this.db
      .select()
      .from(invPlatformPoLines)
      .where(and(eq(invPlatformPoLines.orgId, orgId), eq(invPlatformPoLines.platformPoId, platformPoId)))
      .orderBy(asc(invPlatformPoLines.lineOrder));

    return { ...header, lines };
  }

  /** @see lib/quick-commerce-accept.ts */
  async acceptPurchaseOrder(
    orgId: string,
    userId: string,
    platformPoId: number,
    input: AcceptPlatformPoInput,
    idempotencyKey: string,
  ) {
    return acceptPurchaseOrder(this.qcDeps, orgId, userId, platformPoId, input, idempotencyKey);
  }

  /* ---------------------------------------------------------------- *
   * ASN
   * ---------------------------------------------------------------- */

  /** @see lib/quick-commerce-asn.ts */
  async createAsn(orgId: string, userId: string, input: CreateAsnInput, idempotencyKey: string) {
    return createAsn(this.qcDeps, orgId, userId, input, idempotencyKey);
  }

  /**
   * One ASN, behind the SAME warehouse scope `listAsns` applies.
   *
   * This took no `userId` at all — the controller never passed one — so it
   * answered on `org_id` and the row id alone while the list directly below it
   * resolves the caller's warehouses and gates on them. The list was scoped and
   * the detail was not, which is the same shape as the labour-records hole:
   * whoever cannot see a row in the list can still read it whole by id.
   *
   * Not reachable from the product today, because nothing calls this route yet.
   * That is the reason to fix it now rather than later: the quick-commerce UI is
   * unbuilt, and a detail page wired to an unscoped read is how the hole ships.
   *
   * The predicate matches the LIST's, including `warehouseId IS NULL` — an ASN
   * with no warehouse attributed is visible to everyone there, and a detail that
   * refused those would deny rows the list had just offered. That is a different
   * rule from the labour records, where an unattributed row is excluded; each
   * detail follows its own aggregate rather than a house default.
   *
   * Out of scope is 404, the same answer as a missing row, so this does not
   * become an oracle for which ASNs exist.
   */
  async asnDetail(orgId: string, userId: string, asnId: number) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const conditions = [eq(invAsns.orgId, orgId), eq(invAsns.id, asnId)];
    if (scope !== null) {
      conditions.push(
        scope.length === 0
          ? sql`FALSE`
          : sql`(${invAsns.warehouseId} IS NULL OR ${inArray(invAsns.warehouseId, scope)})`,
      );
    }
    return this.loadAsn(conditions, orgId, asnId);
  }

  /**
   * The unscoped read, named so nobody routes to it by accident.
   *
   * `createAsn` returns the row it has just written, and the writer is entitled
   * to see what they wrote — putting the read gate on that path would 404 a
   * creator against their own new record.
   */
  private async loadAsnUnscoped(orgId: string, asnId: number) {
    return this.loadAsn([eq(invAsns.orgId, orgId), eq(invAsns.id, asnId)], orgId, asnId);
  }

  private async loadAsn(conditions: SQL[], orgId: string, asnId: number) {
    const [header] = await this.db
      .select()
      .from(invAsns)
      .where(and(...conditions));
    if (!header) throw new NotFoundException("Not found");

    const lines = await this.db
      .select()
      .from(invAsnLines)
      .where(and(eq(invAsnLines.orgId, orgId), eq(invAsnLines.asnId, asnId)))
      .orderBy(asc(invAsnLines.lineOrder));

    return { ...header, lines };
  }

  async listAsns(orgId: string, userId: string, query: { poId?: number; status?: string; limit: number; page: number }) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const conditions = [eq(invAsns.orgId, orgId)];
    if (query.poId) conditions.push(eq(invAsns.poId, query.poId));
    if (query.status) conditions.push(sql`${invAsns.status} = ${query.status}`);
    if (scope !== null) {
      conditions.push(
        scope.length === 0
          ? sql`FALSE`
          : sql`(${invAsns.warehouseId} IS NULL OR ${inArray(invAsns.warehouseId, scope)})`,
      );
    }

    return this.db
      .select({
        id: invAsns.id,
        asnNumber: invAsns.asnNumber,
        poId: invAsns.poId,
        platformPoId: invAsns.platformPoId,
        warehouseId: invAsns.warehouseId,
        status: invAsns.status,
        carrierName: invAsns.carrierName,
        appointmentStart: invAsns.appointmentStart,
        appointmentEnd: invAsns.appointmentEnd,
        expectedArrival: invAsns.expectedArrival,
        createdAt: invAsns.createdAt,
      })
      .from(invAsns)
      .where(and(...conditions))
      .orderBy(desc(invAsns.createdAt), desc(invAsns.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
  }

  /** @see lib/quick-commerce-asn.ts */
  async assertReceivable(
    tx: Tx,
    orgId: string,
    params: { poId: number; asnId: number | null },
  ): Promise<void> {
    return assertReceivable(this.qcDeps, tx, orgId, params);
  }

  /**
   * Built explicitly rather than passing `this`: TypeScript will not
   * structurally match a class carrying `private` members to an interface.
   * The two `reload*` closures are what keep the ungated reads private here —
   * see the note in `lib/quick-commerce-ingest.ts`.
   */
  private get qcDeps(): QcIngestDeps & QcAcceptDeps & QcAsnDeps {
    return {
      db: this.db,
      settings: this.settings,
      audit: this.audit,
      numSeq: this.numSeq,
      channelPools: this.channelPools,
      warehouseScope: this.warehouseScope,
      dock: this.dock,
      adapters: this.adapters,
      reloadUnscopedPo: (orgId, platformPoId) => this.detailUnscoped(orgId, platformPoId),
      reloadUnscopedAsn: (orgId, asnId) => this.loadAsnUnscoped(orgId, asnId),
    };
  }
}
