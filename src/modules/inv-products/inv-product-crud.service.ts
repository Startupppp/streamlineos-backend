import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { and, eq, ilike, or, desc, sql, inArray } from "drizzle-orm";
import { assertNoBarcodeConflict } from "./lib/barcode-conflict";
import {
  invProducts,
  invProductVariants,
  invUom,
  invStockLevels,
  invVendors,
  invPurchaseOrders,
  invPoLines,
  invSalesOrders,
  invSoLines,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { InventoryAuditService } from "../inv-stock-engine/inventory-audit.service";
import type {
  CreateProductInput,
  UpdateProductInput,
  ListProductsInput,
} from "./dto/inv-products.schemas";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "23505"
  );
}

@Injectable()
export class InvProductCrudService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
  ) {}

  private async assertNoStockForVariants(
    orgId: string,
    productId: number,
    errorCode: string,
    message: string,
  ): Promise<void> {
    const variants = await this.db.query.invProductVariants.findMany({
      where: and(
        eq(invProductVariants.productId, productId),
        eq(invProductVariants.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (variants.length === 0) return;
    const variantIds = variants.map((v) => v.id);
    const [result] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')`,
      })
      .from(invStockLevels)
      .where(inArray(invStockLevels.productVariantId, variantIds));
    if (parseFloat(result?.total ?? "0") > 0) {
      throw new BadRequestException({ message, code: errorCode });
    }
  }

  private async assertUomBelongsToOrg(
    orgId: string,
    uomId: number,
    fieldName: string,
  ): Promise<void> {
    const uom = await this.db.query.invUom.findFirst({
      where: and(eq(invUom.id, uomId), eq(invUom.orgId, orgId)),
      columns: { id: true },
    });
    if (!uom)
      throw new BadRequestException(
        `${fieldName} refers to a UOM not found in this organisation`,
      );
  }

  private async assertVendorBelongsToOrg(
    orgId: string,
    vendorId: number,
  ): Promise<void> {
    const vendor = await this.db.query.invVendors.findFirst({
      where: and(eq(invVendors.id, vendorId), eq(invVendors.orgId, orgId)),
      columns: { id: true },
    });
    if (!vendor)
      throw new BadRequestException(
        "defaultVendorId refers to a vendor not found in this organisation",
      );
  }

  async listProducts(
    orgId: string,
    filters: ListProductsInput,
    scope: DataScope = "all",
    userId?: string,
  ) {
    if (scope === "none")
      return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, productType, categoryId, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
    const hash = `${status ?? ""}:${productType ?? ""}:${categoryId ?? ""}:${search ?? ""}:${limit}:${offset}${scopeSuffix}`;
    const key = CACHE_KEYS.invProductsList(orgId, hash);

    return this.cache.cached(
      key,
      async () => {
        const conditions = [eq(invProducts.orgId, orgId)];
        if (status) conditions.push(eq(invProducts.status, status));
        if (productType)
          conditions.push(eq(invProducts.productType, productType));
        if (categoryId) conditions.push(eq(invProducts.categoryId, categoryId));
        if (search) {
          conditions.push(
            or(
              ilike(invProducts.name, `%${search}%`),
              ilike(invProducts.sku, `%${search}%`),
            )!,
          );
        }
        if (scope !== "all" && userId) {
          conditions.push(
            applyScope(scope, userId, { ownerColumn: invProducts.createdBy }),
          );
        }
        const where = and(...conditions);

        const [items, countResult] = await Promise.all([
          this.db.query.invProducts.findMany({
            where,
            orderBy: [desc(invProducts.createdAt)],
            limit,
            offset,
            with: {
              category: { columns: { id: true, name: true } },
              uom: { columns: { id: true, name: true, abbreviation: true } },
              variants: {
                columns: { id: true, sku: true, name: true, isActive: true },
              },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invProducts)
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

  async getProduct(orgId: string, productId: number) {
    const product = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      with: {
        category: true,
        uom: true,
        variants: true,
        creator: { columns: { id: true, name: true } },
      },
    });
    if (!product) throw new NotFoundException("Product not found");
    return product;
  }

  private async generateNextSku(orgId: string): Promise<string> {
    const [row] = await this.db
      .select({
        maxSeq: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invProducts.sku} FROM 6) AS INTEGER)), 0)`,
      })
      .from(invProducts)
      .where(
        and(
          eq(invProducts.orgId, orgId),
          sql`${invProducts.sku} ~ '^PROD-[0-9]+$'`,
        ),
      );

    const next = Number(row?.maxSeq ?? 0) + 1;
    return `PROD-${String(next).padStart(3, "0")}`;
  }

  async createProduct(orgId: string, userId: string, data: CreateProductInput) {
    if (data.barcode) await assertNoBarcodeConflict(this.db, orgId, data.barcode);
    if (data.purchaseUomId)
      await this.assertUomBelongsToOrg(
        orgId,
        data.purchaseUomId,
        "purchaseUomId",
      );
    if (data.salesUomId)
      await this.assertUomBelongsToOrg(orgId, data.salesUomId, "salesUomId");
    if (data.defaultVendorId)
      await this.assertVendorBelongsToOrg(orgId, data.defaultVendorId);

    const { sku: providedSku, ...rest } = data;
    const maxAttempts = providedSku ? 1 : 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sku = providedSku ?? (await this.generateNextSku(orgId));

      if (providedSku) {
        const existing = await this.db.query.invProducts.findFirst({
          where: and(eq(invProducts.orgId, orgId), eq(invProducts.sku, sku)),
          columns: { id: true },
        });
        if (existing)
          throw new ConflictException("A product with this SKU already exists");
      }

      try {
        const [product] = await this.db
          .insert(invProducts)
          .values({
            orgId,
            createdBy: userId,
            ...rest,
            sku,
          })
          .returning();

        if (!data.hasVariants) {
          await this.db.insert(invProductVariants).values({
            orgId,
            productId: product.id,
            name: data.name,
            sku,
            barcode: data.barcode,
            costPrice: data.costPrice ?? "0",
            sellingPrice: data.sellingPrice ?? "0",
            attributeValues: {},
          });
        }

        await this.cache.invalidatePattern(`inv:products:list:${orgId}:*`);
        return product;
      } catch (err) {
        if (!providedSku && isUniqueViolation(err)) continue;
        if (isUniqueViolation(err)) {
          throw new ConflictException("A product with this SKU already exists");
        }
        throw err;
      }
    }

    throw new ConflictException(
      "Could not allocate a unique SKU. Please retry.",
    );
  }

  async updateProduct(
    orgId: string,
    productId: number,
    data: UpdateProductInput,
  ) {
    const existing = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true, trackingMethod: true, costingMethod: true },
    });
    if (!existing) throw new NotFoundException("Product not found");

    if (
      data.trackingMethod &&
      data.trackingMethod !== existing.trackingMethod
    ) {
      await this.assertNoStockForVariants(
        orgId,
        productId,
        "TRACKING_METHOD_LOCKED",
        "Cannot change tracking method while non-zero stock exists",
      );
    }
    if (data.costingMethod && data.costingMethod !== existing.costingMethod) {
      await this.assertNoStockForVariants(
        orgId,
        productId,
        "COSTING_METHOD_LOCKED",
        "Cannot change costing method while non-zero stock exists",
      );
    }
    if (data.barcode)
      await assertNoBarcodeConflict(this.db, orgId, data.barcode, productId);
    if (data.purchaseUomId)
      await this.assertUomBelongsToOrg(
        orgId,
        data.purchaseUomId,
        "purchaseUomId",
      );
    if (data.salesUomId)
      await this.assertUomBelongsToOrg(orgId, data.salesUomId, "salesUomId");
    if (data.defaultVendorId)
      await this.assertVendorBelongsToOrg(orgId, data.defaultVendorId);

    const [updated] = await this.db
      .update(invProducts)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)))
      .returning();

    await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
    await this.cache.invalidatePattern(`inv:products:list:${orgId}:*`);
    return updated;
  }

  async deleteProduct(orgId: string, productId: number) {
    const existing = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Product not found");

    const variants = await this.db.query.invProductVariants.findMany({
      where: and(
        eq(invProductVariants.productId, productId),
        eq(invProductVariants.orgId, orgId),
      ),
      columns: { id: true },
    });

    if (variants.length > 0) {
      const variantIds = variants.map((v) => v.id);

      const [stockRows, openPoLines, openSoLines] = await Promise.all([
        this.db
          .select({
            total: sql<string>`COALESCE(SUM(${invStockLevels.onHand}), '0')`,
          })
          .from(invStockLevels)
          .where(inArray(invStockLevels.productVariantId, variantIds)),
        this.db
          .select({ id: invPoLines.id })
          .from(invPoLines)
          .innerJoin(
            invPurchaseOrders,
            eq(invPoLines.poId, invPurchaseOrders.id),
          )
          .where(
            and(
              inArray(invPoLines.productVariantId, variantIds),
              inArray(invPurchaseOrders.status, ["DRAFT", "SENT", "PARTIAL"]),
            ),
          )
          .limit(1),
        this.db
          .select({ id: invSoLines.id })
          .from(invSoLines)
          .innerJoin(invSalesOrders, eq(invSoLines.soId, invSalesOrders.id))
          .where(
            and(
              inArray(invSoLines.productVariantId, variantIds),
              inArray(invSalesOrders.status, ["DRAFT", "CONFIRMED"]),
            ),
          )
          .limit(1),
      ]);

      if (parseFloat(stockRows[0]?.total ?? "0") > 0) {
        throw new ConflictException(
          "Cannot delete product with existing stock. Archive it instead.",
        );
      }

      if (openPoLines.length > 0 || openSoLines.length > 0) {
        throw new ConflictException(
          "Cannot delete product referenced in open purchase or sales orders. Archive it instead.",
        );
      }
    }

    await this.db
      .delete(invProducts)
      .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)));
    await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
    await this.cache.invalidatePattern(`inv:products:list:${orgId}:*`);
  }

  async archiveProduct(orgId: string, productId: number, userId: string) {
    const existing = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException("Product not found");

    const [updated] = await this.db
      .update(invProducts)
      .set({ status: "INACTIVE", updatedAt: new Date() })
      .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)))
      .returning();

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "product.archive",
      resourceType: "product",
      resourceId: String(productId),
      before: { status: existing.status },
      after: { status: "INACTIVE" },
    });

    await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
    await this.cache.invalidatePattern(`inv:products:list:${orgId}:*`);
    return updated;
  }

  async restoreProduct(orgId: string, productId: number, userId: string) {
    const existing = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException("Product not found");

    const [updated] = await this.db
      .update(invProducts)
      .set({ status: "ACTIVE", updatedAt: new Date() })
      .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)))
      .returning();

    await this.audit.insert(this.db, {
      orgId,
      actorUserId: userId,
      action: "product.restore",
      resourceType: "product",
      resourceId: String(productId),
      before: { status: existing.status },
      after: { status: "ACTIVE" },
    });

    await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
    await this.cache.invalidatePattern(`inv:products:list:${orgId}:*`);
    return updated;
  }
}
