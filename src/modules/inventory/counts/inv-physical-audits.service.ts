import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { invPhysicalAudits, invPhysicalAuditLines } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
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
  ) {}

  async listAudits(orgId: string, filters: ListCountsInput) {
    const { status, warehouseId, page, limit } = filters;
    const offset = (page - 1) * limit;
    const hash = `${status ?? ""}:${warehouseId ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(PA_LIST_NAMESPACE(orgId), hash, async () => {
      const conditions = [eq(invPhysicalAudits.orgId, orgId)];
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

  async getAudit(orgId: string, auditId: number) {
    const audit = await this.db.query.invPhysicalAudits.findFirst({
      where: and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)),
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
          auditId: audit.id,
          productVariantId: row.product_variant_id,
          locationId: row.location_id,
          lotId: row.lot_id ?? null,
          systemQty: row.on_hand,
        }))
      );
    }

    await this.cache.invalidateNamespace(PA_LIST_NAMESPACE(orgId));
    return this.getAudit(orgId, audit.id);
  }

  async startAudit(orgId: string, auditId: number) {
    const audit = await this.requireAudit(orgId, auditId);
    if (audit.status !== "PLANNED") throw new BadRequestException("Only PLANNED audits can be started");

    await this.db.update(invPhysicalAudits)
      .set({ status: "COUNTING" })
      .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

    await this.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
    return this.getAudit(orgId, auditId);
  }

  async updateLines(orgId: string, auditId: number, data: UpdateCountLinesInput) {
    const audit = await this.requireAudit(orgId, auditId);
    if (audit.status !== "COUNTING") throw new BadRequestException("Lines can only be updated while status is COUNTING");

    if (data.lines.length > 0) {
      const values = sql.join(
        data.lines.map(
          (update) => sql`(${update.lineId}, ${update.countedQty.toFixed(4)}::numeric)`,
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
    return this.getAudit(orgId, auditId);
  }

  async reviewAudit(orgId: string, auditId: number) {
    const audit = await this.requireAudit(orgId, auditId);
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
    return this.getAudit(orgId, auditId);
  }

  async postAudit(orgId: string, userId: string, auditId: number, idempotencyKey: string) {
    const audit = await this.requireAudit(orgId, auditId);
    if (audit.status !== "REVIEW") throw new BadRequestException("Only REVIEW audits can be posted");

    const lines = await this.db.query.invPhysicalAuditLines.findMany({
      where: eq(invPhysicalAuditLines.auditId, auditId),
      columns: { productVariantId: true, locationId: true, varianceQty: true },
    });

    const movements = lines
      .filter((l) => l.varianceQty !== null && parseFloat(l.varianceQty) !== 0)
      .map((l) => {
        const v = parseFloat(l.varianceQty!);
        return {
          transactionType: v > 0 ? "CYCLE_COUNT_GAIN" as const : "CYCLE_COUNT_LOSS" as const,
          productVariantId: l.productVariantId,
          locationId: l.locationId,
          quantityDelta: v.toFixed(4),
        };
      });

    if (movements.length > 0) {
      await this.engine.execute(orgId, userId, {
        idempotencyKey,
        sourceType: "inv_physical_audit",
        sourceId: auditId.toString(),
        reason: `Physical audit ${audit.auditNumber}`,
        movements,
      });
    }

    await this.db.update(invPhysicalAudits)
      .set({ status: "POSTED", postedAt: new Date(), approvedBy: userId })
      .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

    await this.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
    await this.cache.invalidateNamespace(PA_LIST_NAMESPACE(orgId));
    return this.getAudit(orgId, auditId);
  }

  async cancelAudit(orgId: string, auditId: number) {
    const audit = await this.requireAudit(orgId, auditId);
    if (audit.status === "POSTED") throw new BadRequestException("Posted audits cannot be cancelled");

    await this.db.update(invPhysicalAudits)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)));

    await this.cache.invalidate(PA_DETAIL_KEY(orgId, auditId));
  }

  private async requireAudit(orgId: string, auditId: number) {
    const audit = await this.db.query.invPhysicalAudits.findFirst({
      where: and(eq(invPhysicalAudits.orgId, orgId), eq(invPhysicalAudits.id, auditId)),
      columns: { id: true, status: true, auditNumber: true },
    });
    if (!audit) throw new NotFoundException("Physical audit not found");
    return audit;
  }
}
