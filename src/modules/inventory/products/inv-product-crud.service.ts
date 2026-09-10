import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { assertNoBarcodeConflict } from "./lib/barcode-conflict";
import {
  assertCaptureConfig,
  assertNoStockForVariants,
  assertPacksForFields,
  assertUomBelongsToOrg,
  assertVendorBelongsToOrg,
  type ProductAssertionDeps,
} from "./lib/product-assertions";
import { getProduct, listProducts, type ProductReadDeps } from "./lib/product-reads";
import { deleteProduct, type ProductDeleteDeps } from "./lib/product-delete";
import {
  archiveProduct,
  restoreProduct,
  type ProductArchiveDeps,
} from "./lib/product-archive";
import {
  invProducts,
  invProductVariants,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import type { DataScope } from "../../access/access.types";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { CostVisibilityService } from "../stock-engine/cost-visibility";
import type {
  CreateProductInput,
  UpdateProductInput,
  ListProductsInput,
} from "./dto/inv-products.schemas";

@Injectable()
export class InvProductCrudService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
    private readonly costVisibility: CostVisibilityService,
    private readonly settings: InventorySettingsService,
  ) {}

  /** @see lib/product-reads.ts */
  async listProducts(
    orgId: string,
    query: ListProductsInput,
    scope?: DataScope,
    userId?: string,
  ) {
    return listProducts(this.productDeps, orgId, query, scope, userId);
  }

  /** @see lib/product-reads.ts */
  async getProduct(orgId: string, productId: number, userId?: string, includeDeleted = false) {
    return getProduct(this.productDeps, orgId, productId, userId, includeDeleted);
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
    await assertPacksForFields(this.productDeps, orgId, data);
    await assertCaptureConfig(this.productDeps, orgId, null, data);
    if (data.barcode) await assertNoBarcodeConflict(this.db, orgId, data.barcode);
    if (data.purchaseUomId)
      await assertUomBelongsToOrg(this.productDeps, 
        orgId,
        data.purchaseUomId,
        "purchaseUomId",
      );
    if (data.salesUomId)
      await assertUomBelongsToOrg(this.productDeps, orgId, data.salesUomId, "salesUomId");
    if (data.defaultVendorId)
      await assertVendorBelongsToOrg(this.productDeps, orgId, data.defaultVendorId);

    const { sku: providedSku, ...rest } = data;
    const maxAttempts = providedSku ? 1 : 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sku = providedSku ?? (await this.generateNextSku(orgId));

      if (providedSku) {
        // The uniqueness index is partial on deleted_at IS NULL, so a SKU
        // freed by a deletion is available again and this pre-check has to agree.
        const existing = await this.db.query.invProducts.findFirst({
          where: and(
            eq(invProducts.orgId, orgId),
            eq(invProducts.sku, sku),
            isNull(invProducts.deletedAt),
          ),
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

        await this.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
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
    await assertPacksForFields(this.productDeps, orgId, data);
    await assertCaptureConfig(this.productDeps, orgId, productId, data);
    const existing = await this.db.query.invProducts.findFirst({
      where: and(
        eq(invProducts.id, productId),
        eq(invProducts.orgId, orgId),
        isNull(invProducts.deletedAt),
      ),
      columns: { id: true, trackingMethod: true, costingMethod: true },
    });
    if (!existing) throw new NotFoundException("Product not found");

    if (
      data.trackingMethod &&
      data.trackingMethod !== existing.trackingMethod
    ) {
      await assertNoStockForVariants(this.productDeps, 
        orgId,
        productId,
        "TRACKING_METHOD_LOCKED",
        "Cannot change tracking method while non-zero stock exists",
      );
    }
    if (data.costingMethod && data.costingMethod !== existing.costingMethod) {
      await assertNoStockForVariants(this.productDeps, 
        orgId,
        productId,
        "COSTING_METHOD_LOCKED",
        "Cannot change costing method while non-zero stock exists",
      );
    }
    if (data.barcode)
      await assertNoBarcodeConflict(this.db, orgId, data.barcode, productId);
    if (data.purchaseUomId)
      await assertUomBelongsToOrg(this.productDeps, 
        orgId,
        data.purchaseUomId,
        "purchaseUomId",
      );
    if (data.salesUomId)
      await assertUomBelongsToOrg(this.productDeps, orgId, data.salesUomId, "salesUomId");
    if (data.defaultVendorId)
      await assertVendorBelongsToOrg(this.productDeps, orgId, data.defaultVendorId);

    const [updated] = await this.db
      .update(invProducts)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)))
      .returning();

    await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
    await this.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
    return updated;
  }

  /** @see lib/product-delete.ts */
  async deleteProduct(orgId: string, productId: number, userId: string) {
    return deleteProduct(this.productDeps, orgId, productId, userId);
  }

  /** @see lib/product-archive.ts */
  async archiveProduct(orgId: string, productId: number, userId: string) {
    return archiveProduct(this.productDeps, orgId, productId, userId);
  }

  /** @see lib/product-archive.ts */
  async restoreProduct(orgId: string, productId: number, userId: string) {
    return restoreProduct(this.productDeps, orgId, productId, userId);
  }

  /**
   * Built explicitly rather than passing `this`: TypeScript will not
   * structurally match a class carrying `private` members to an interface.
   */
  private get productDeps(): ProductAssertionDeps &
    ProductReadDeps &
    ProductDeleteDeps &
    ProductArchiveDeps {
    return {
      db: this.db,
      cache: this.cache,
      audit: this.audit,
      costVisibility: this.costVisibility,
      settings: this.settings,
    };
  }

}
