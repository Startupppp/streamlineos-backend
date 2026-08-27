import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  invProductVariants,
  invSalesOrders,
  invSoLines,
  invStockLevels,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { SoLifecycleService } from "./so-lifecycle.service";
import { addDec, mulDec } from "../stock-engine/stock-engine.service";
import type {
  CreateSoInput,
  ListSoInput,
  UpdateSoInput,
} from "./dto/inv-sales-orders.schemas";

function computeSoTotals(
  lines: Array<{ quantity: number; unitPrice: string; taxRate: string }>,
) {
  let subtotal = "0";
  let taxAmount = "0";
  for (const l of lines) {
    const lineAmt = mulDec(l.quantity.toFixed(4), l.unitPrice);
    subtotal = addDec(subtotal, lineAmt);
    taxAmount = addDec(
      taxAmount,
      mulDec(lineAmt, (parseFloat(l.taxRate) / 100).toFixed(10)),
    );
  }
  return {
    subtotal,
    taxAmount,
    total: addDec(subtotal, taxAmount),
  };
}

@Injectable()
export class SoCoreService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly numSeq: NumberSequenceService,
    private readonly lifecycle: SoLifecycleService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

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
        if (warehouses) conditions.push(warehouses.warehouse(sql`${invSalesOrders.warehouseId}`));
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

  async getSo(orgId: string, soId: number) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
      with: {
        client: true,
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
    return so;
  }

  async createSo(orgId: string, userId: string, data: CreateSoInput) {
    const soNumber = await this.numSeq.next(orgId, "SO");
    const { subtotal, taxAmount, total } = computeSoTotals(data.lines);

    const variantIds = data.lines.map((l) => l.productVariantId);
    const variants = await this.db.query.invProductVariants.findMany({
      where: inArray(invProductVariants.id, variantIds),
      columns: { id: true, costPrice: true },
    });
    const variantCostMap = new Map(variants.map((v) => [v.id, v.costPrice]));

    const so = await this.db.transaction(async (tx) => {
      const [header] = await (tx as Db)
        .insert(invSalesOrders)
        .values({
          orgId,
          clientId: data.clientId,
          soNumber,
          orderDate: data.orderDate,
          requiredDate: data.requiredDate,
          shippingAddress: data.shippingAddress,
          warehouseId: data.warehouseId,
          subtotal,
          taxAmount,
          discount: "0",
          total,
          currency: data.currency,
          notes: data.notes,
          createdBy: userId,
        })
        .returning();

      await (tx as Db).insert(invSoLines).values(
        data.lines.map((line) => ({
          orgId,
          soId: header.id,
          productVariantId: line.productVariantId,
          quantity: line.quantity.toString(),
          unitPrice: line.unitPrice,
          taxRate: line.taxRate,
          amount: mulDec(line.quantity.toFixed(4), line.unitPrice),
          costAtTime: variantCostMap.get(line.productVariantId) ?? "0",
          lineOrder: line.lineOrder,
        })),
      );

      return header;
    });

    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
    return so;
  }

  async updateSo(orgId: string, soId: number, data: UpdateSoInput) {
    const so = await this.db.query.invSalesOrders.findFirst({
      where: and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
    });
    if (!so) throw new NotFoundException("Sales order not found");
    if (so.status !== "DRAFT")
      throw new BadRequestException("Only DRAFT sales orders can be updated");

    const patch: Partial<typeof invSalesOrders.$inferInsert> = {};
    if (data.clientId !== undefined) patch.clientId = data.clientId;
    if (data.orderDate !== undefined) patch.orderDate = data.orderDate;
    if (data.requiredDate !== undefined) patch.requiredDate = data.requiredDate;
    if (data.shippingAddress !== undefined)
      patch.shippingAddress = data.shippingAddress;
    if (data.warehouseId !== undefined) patch.warehouseId = data.warehouseId;
    if (data.currency !== undefined) patch.currency = data.currency;
    if (data.notes !== undefined) patch.notes = data.notes;

    let variantCostMap = new Map<number, string>();
    if (data.lines) {
      const { subtotal, taxAmount, total } = computeSoTotals(data.lines);
      patch.subtotal = subtotal;
      patch.taxAmount = taxAmount;
      patch.total = total;

      const variantIds = data.lines.map((l) => l.productVariantId);
      const variants = await this.db.query.invProductVariants.findMany({
        where: inArray(invProductVariants.id, variantIds),
        columns: { id: true, costPrice: true },
      });
      variantCostMap = new Map(variants.map((v) => [v.id, v.costPrice]));
    }

    await this.db.transaction(async (tx) => {
      if (data.lines) {
        await (tx as Db).delete(invSoLines).where(eq(invSoLines.soId, soId));

        await (tx as Db).insert(invSoLines).values(
          (data.lines ?? []).map((line) => ({
            orgId,
            soId,
            productVariantId: line.productVariantId,
            quantity: line.quantity.toString(),
            unitPrice: line.unitPrice,
            taxRate: line.taxRate,
            amount: mulDec(line.quantity.toFixed(4), line.unitPrice),
            costAtTime: variantCostMap.get(line.productVariantId) ?? "0",
            lineOrder: line.lineOrder,
          })),
        );
      }

      if (Object.keys(patch).length > 0) {
        await (tx as Db)
          .update(invSalesOrders)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(eq(invSalesOrders.id, soId), eq(invSalesOrders.orgId, orgId)),
          );
      }
    });

    await this.cache.del(CACHE_KEYS.invSoDetail(orgId, soId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invSoNamespace(orgId));
    return this.getSo(orgId, soId);
  }

  async getAtp(orgId: string, productVariantIds: number[]) {
    if (productVariantIds.length === 0) return [];

    const levels = await this.db.query.invStockLevels.findMany({
      where: and(
        eq(invStockLevels.orgId, orgId),
        inArray(invStockLevels.productVariantId, productVariantIds),
      ),
      columns: {
        productVariantId: true,
        onHand: true,
        committed: true,
        onOrder: true,
        blockedQty: true,
        qualityHoldQty: true,
      },
    });

    const grouped = new Map<
      number,
      {
        onHand: number;
        committed: number;
        onOrder: number;
        blocked: number;
        qualityHold: number;
      }
    >();

    for (const l of levels) {
      const existing = grouped.get(l.productVariantId);
      const onHand = parseFloat(l.onHand);
      const committed = parseFloat(l.committed);
      const onOrder = parseFloat(l.onOrder);
      const blocked = parseFloat(l.blockedQty ?? "0");
      const qualityHold = parseFloat(l.qualityHoldQty ?? "0");

      if (existing) {
        existing.onHand += onHand;
        existing.committed += committed;
        existing.onOrder += onOrder;
        existing.blocked += blocked;
        existing.qualityHold += qualityHold;
      } else {
        grouped.set(l.productVariantId, {
          onHand,
          committed,
          onOrder,
          blocked,
          qualityHold,
        });
      }
    }

    return productVariantIds.map((id) => {
      const agg = grouped.get(id);
      const onHand = agg?.onHand ?? 0;
      const committed = agg?.committed ?? 0;
      const blocked = agg?.blocked ?? 0;
      const qualityHold = agg?.qualityHold ?? 0;
      const onOrder = agg?.onOrder ?? 0;
      return {
        productVariantId: id,
        onHand,
        committed,
        blocked,
        qualityHold,
        onOrder,
        available: onHand - committed - blocked - qualityHold,
        incomingQty: onOrder,
        outgoingQty: committed,
      };
    });
  }

  confirmSo(orgId: string, soId: number, userId: string) {
    return this.lifecycle.confirmSo(orgId, soId, userId);
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
    qty: number,
    strategy: string,
    expiryPolicy: string,
  ) {
    return this.lifecycle.findAvailableLotForLine(
      orgId,
      variantId,
      warehouseId,
      qty,
      strategy,
      expiryPolicy,
    );
  }
}
