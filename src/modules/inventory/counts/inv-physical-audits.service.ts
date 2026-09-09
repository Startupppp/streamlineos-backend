import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { invPhysicalAudits, invPhysicalAuditLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { buildCountVarianceMovements } from "./count-variance-movements";
import {
  INVENTORY_COMMAND_EVENTS,
  emitInventoryCommandEvent,
} from "../stock-engine/command-events";
import type { ListCountsInput, CreateAuditInput, UpdateCountLinesInput } from "./dto/inv-counts.schemas";

const PA_LIST_NAMESPACE = (orgId: string) => `inv:physical-audits:list:${orgId}`;
const PA_DETAIL_KEY = (orgId: string, id: number) => `inv:physical-audits:detail:${orgId}:${id}`;

@Injectable()
export class InvPhysicalAuditsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly numSeq: NumberSequenceService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  async listAudits(orgId: string, userId: string, filters: ListCountsInput) {
    const { status, warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${status ?? ""}:${warehouseId ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(PA_LIST_NAMESPACE(orgId), hash, async () => {
      const conditions = [eq(invPhysicalAudits.orgId, orgId), scope.warehouse(sql`${invPhysicalAudits.warehouseId}`)];
      if (status) conditions.push(eq(invPhysicalAudits.status, status));
      if (warehouseId) conditions.push(eq(invPhysicalAudits.warehouseId, warehouseId));
      const where = and(...conditions);

      const [items, countResult] = await Promise.all([
        this.db.query.invPhysicalAudits.findMany({
          where,
          orderBy: [desc(invPhysicalAudits.createdAt)],
          limit,
          offset,
          with: { creator: { columns: { id: true, name: true } } },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invPhysicalAudits).where(where),
      ]);

      const total = countResult[0]?.count ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  /**
   * One audit, behind the SAME warehouse scope `listAudits` applies.
   *
   * Same shape as the cycle-count detail beside it: no caller id in the
   * signature at all, so it answered on `org_id` and the row id while the list
   * above resolves the caller's warehouses. A wall-to-wall audit is the whole
   * stock position of a building at a moment in time, line by line — the thing
   * a warehouse scope exists to keep from leaking sideways.
   *
   * NULL WAREHOUSE — EXCLUDED, following this table's own aggregate. `listAudits`
   * gates through `scope.warehouse(...)`, which is `warehousePredicate` and
   * renders `warehouse_id IN (...)` with no `IS NULL` arm, so an unattributed
   * audit is invisible in the list and invisible here. Deliberately NOT the ASN
   * rule, where the list keeps unattributed rows and the detail had to keep them
   * too. `inv_physical_audits.warehouse_id` is `NOT NULL` today, so this is a
   * rule for the next person rather than a live branch.
   *
   * Out of scope answers 404, never 403 (§4). An empty scope compiles to `FALSE`
   * in the WHERE, which is what the list does with it.
   */
  async getAudit(orgId: string, userId: string, auditId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    return this.loadAudit(orgId, auditId, [scope.warehouse(sql`${invPhysicalAudits.warehouseId}`)]);
  }

  /**
   * The unscoped read, named so nobody routes to it by accident.
   *
   * `createAudit` returns the audit it has just written and the writer is
   * entitled to see what they wrote; everybody else has already passed
   * `requireAudit` for this id. A named private method rather than a flag on the
   * public one, so a future route cannot be pointed at it.
   */
  private async loadAuditUnscoped(orgId: string, auditId: number) {
    return this.loadAudit(orgId, auditId, []);
  }

  private async loadAudit(orgId: string, auditId: number, scoped: SQL[]) {
    const audit = await this.db.query.invPhysicalAudits.findFirst({
      where: and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId), ...scoped),
      with: {
        creator: { columns: { id: true, name: true } },
        lines: {
          with: {
            productVariant: { with: { product: { columns: { id: true, name: true, sku: true } } } },
            location: { columns: { id: true, name: true, code: true } },
          },
        },
      },
    });
    if (!audit) throw new NotFoundException("Physical audit not found");
    return audit;
  }

  async createAudit(orgId: string, userId: string, data: CreateAuditInput) {
    // The warehouse is the caller's claim, straight off the body. Ungated, a
    // planner scoped to one building could open an audit of another and have
    // every stock level in it copied into the audit lines and returned — the
    // detail-read disclosure, reached through the create instead.
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, data.warehouseId);

    const auditNumber = await this.numSeq.next(orgId, "PHYSICAL_AUDIT");

    const [audit] = await this.db.insert(invPhysicalAudits).values({
      orgId,
      auditNumber,
      warehouseId: data.warehouseId,
      status: "PLANNED",
      createdBy: userId,
    }).returning();

    const stockLevels = await this.db.execute<{
      product_variant_id: number; location_id: number; lot_id: number | null; on_hand: string;
    }>(sql`
      SELECT sl.product_variant_id, sl.location_id, sl.lot_id, sl.on_hand
      FROM inv_stock_levels sl
      JOIN inv_locations loc ON loc.id = sl.location_id
      WHERE sl.org_id = ${orgId} AND loc.warehouse_id = ${data.warehouseId}
    `);

    if (stockLevels.length > 0) {
      await this.db.insert(invPhysicalAuditLines).values(
        stockLevels.map((row) => ({
          orgId,
          auditId: audit.id,
          productVariantId: row.product_variant_id,
          locationId: row.location_id,
          lotId: row.lot_id ?? null,
          systemQty: row.on_hand,
        }))
      );
    }

    await this.cache.invalidateNamespace(PA_LIST_NAMESPACE(orgId));
    return this.loadAuditUnscoped(orgId, audit.id);
  }

  async startAudit(orgId: string, userId: string, auditId: number) {
    const audit = await this.requireAudit(orgId, userId, auditId);
    if (audit.status !== "PLANNED") throw new BadRequestException("Only PLANNED audits can be started");

    await this.db.update(invPhysicalAudits)
      .set({ status: "COUNTING" })
      .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

    await this.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
    return this.loadAuditUnscoped(orgId, auditId);
  }

  async updateLines(orgId: string, userId: string, auditId: number, data: UpdateCountLinesInput) {
    const audit = await this.requireAudit(orgId, userId, auditId);
    if (audit.status !== "COUNTING") throw new BadRequestException("Lines can only be updated while status is COUNTING");

    if (data.lines.length > 0) {
      // Same untyped-parameter defect as the cycle-count path: a bound value in
      // a `VALUES` list is `text` until it is cast, so the join to an `integer`
      // id failed outright and no audit line could ever record what was counted.
      const values = sql.join(
        data.lines.map(
          (update) => sql`(${update.lineId}::int, ${update.countedQty.toFixed(4)}::numeric)`,
        ),
        sql`, `,
      );
      await this.db.execute(sql`
        UPDATE ${invPhysicalAuditLines}
        SET counted_qty = updates.counted_qty
        FROM (VALUES ${values}) AS updates(id, counted_qty)
        WHERE ${invPhysicalAuditLines.id} = updates.id
          AND ${invPhysicalAuditLines.auditId} = ${auditId}
      `);
    }

    await this.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
    return this.loadAuditUnscoped(orgId, auditId);
  }

  async reviewAudit(orgId: string, userId: string, auditId: number) {
    const audit = await this.requireAudit(orgId, userId, auditId);
    if (audit.status !== "COUNTING") throw new BadRequestException("Only COUNTING audits can move to REVIEW");

    await this.db
      .update(invPhysicalAuditLines)
      .set({
        varianceQty: sql`coalesce(${invPhysicalAuditLines.countedQty}, 0) - ${invPhysicalAuditLines.systemQty}`,
      })
      .where(eq(invPhysicalAuditLines.auditId, auditId));

    await this.db.update(invPhysicalAudits)
      .set({ status: "REVIEW" })
      .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

    await this.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
    return this.loadAuditUnscoped(orgId, auditId);
  }

  async postAudit(orgId: string, userId: string, auditId: number, idempotencyKey: string) {
    const audit = await this.requireAudit(orgId, userId, auditId);
    if (audit.status !== "REVIEW") throw new BadRequestException("Only REVIEW audits can be posted");

    // Same grain rule as the cycle count: the audit line records the lot its
    // `systemQty` was read from, so the correction has to name it or it lands
    // on a different level than the one that was counted.
    const lines = await this.db.query.invPhysicalAuditLines.findMany({
      where: eq(invPhysicalAuditLines.auditId, auditId),
      columns: { productVariantId: true, locationId: true, lotId: true, varianceQty: true },
    });

    const movements = buildCountVarianceMovements(lines);

    if (movements.length > 0) {
      await this.engine.execute(orgId, userId, {
        idempotencyKey,
        sourceType: "inv_physical_audit",
        sourceId: auditId.toString(),
        reason: `Physical audit ${audit.auditNumber}`,
        movements,
      });
    }

    // A5. The status flip and its event share a transaction, so the event
    // cannot survive a posting that rolled back. The movements above are the
    // engine's own transaction, and carry the engine's own event; this one is
    // about the document.
    await this.db.transaction(async (tx) => {
      const posted = await tx.update(invPhysicalAudits)
        .set({ status: "POSTED", postedAt: new Date(), approvedBy: userId })
        .where(and(
          eq(invPhysicalAudits.orgId, orgId),
          eq(invPhysicalAudits.id, auditId),
          eq(invPhysicalAudits.status, "REVIEW"),
        ))
        .returning({ id: invPhysicalAudits.id });

      if (posted.length === 0) return;

      await emitInventoryCommandEvent(tx, {
        orgId,
        eventType: INVENTORY_COMMAND_EVENTS.COUNT_POSTED,
        aggregateType: "inv_physical_audit",
        aggregateId: String(auditId),
        actorUserId: userId,
        payload: {
          countType: "PHYSICAL",
          countId: auditId,
          countNumber: audit.auditNumber,
          warehouseId: audit.warehouseId,
          lineCount: lines.length,
          varianceLineCount: movements.length,
          idempotencyKey,
        },
      });
    });

    await this.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
    await this.cache.invalidateNamespace(PA_LIST_NAMESPACE(orgId));
    return this.loadAuditUnscoped(orgId, auditId);
  }

  async cancelAudit(orgId: string, userId: string, auditId: number) {
    const audit = await this.requireAudit(orgId, userId, auditId);
    if (audit.status === "POSTED") throw new BadRequestException("Posted audits cannot be cancelled");

    await this.db.update(invPhysicalAudits)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

    await this.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
  }

  /**
   * The gate every mutation funnels through, now carrying the caller.
   *
   * `start`, `updateLines`, `review`, `post` and `cancel` all reach the row
   * through here and none took a caller id, so an auditor scoped to one building
   * could start, rewrite every variance on, post or cancel the wall-to-wall
   * audit of another — and posting one writes stock movements against the real
   * books. Same predicate as `listAudits` (see `getAudit` for the NULL-warehouse
   * rule), same 404 for out of scope.
   */
  private async requireAudit(orgId: string, userId: string, auditId: number) {
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const audit = await this.db.query.invPhysicalAudits.findFirst({
      where: and(
        eq(invPhysicalAudits.orgId, orgId),
        eq(invPhysicalAudits.id, auditId),
        scope.warehouse(sql`${invPhysicalAudits.warehouseId}`),
      ),
      columns: { id: true, status: true, auditNumber: true, warehouseId: true },
    });
    if (!audit) throw new NotFoundException("Physical audit not found");
    return audit;
  }
}
