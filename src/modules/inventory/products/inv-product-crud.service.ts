import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { CostVisibilityService, stripCostFields } from "../stock-engine/cost-visibility";
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
    private readonly costVisibility: CostVisibilityService,
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

    const { status, productType, categoryId, search, page, limit, includeDeleted } = filters;
    const offset = (page - 1) * limit;
    // Cost visibility is part of the key: this list is cached per org, so a
    // masked payload must not be served to a cost-permitted caller or vice versa.
    const showCost = userId ? await this.costVisibility.canSeeCost(orgId, userId) : false;
    const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
    const hash = `${showCost ? "cost" : "nocost"}:${status ?? ""}:${productType ?? ""}:${categoryId ?? ""}:${search ?? ""}:${includeDeleted ? "withdeleted" : "live"}:${limit}:${offset}${scopeSuffix}`;
    return this.cache.cachedVersioned(
      CACHE_KEYS.invProductsNamespace(orgId),
      hash,
      async () => {
        // A deleted product must not come back through a list unless the caller
        // asked for it. The partial index on (org_id, id) WHERE deleted_at IS
        // NULL covers the default predicate.
        const conditions = [eq(invProducts.orgId, orgId)];
        if (!includeDeleted) conditions.push(isNull(invProducts.deletedAt));
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
            applyScope(scope, orgId, userId, { ownerColumn: invProducts.createdBy }),
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
          items: showCost ? items : stripCostFields(items),
          total: countResult[0]?.count ?? 0,
          page,
          totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  /**
   * A4. `includeDeleted` exists so a soft-deleted product can be looked at
   * before it is restored. A list that can show one and a detail page that
   * 404s on it is a dead end.
   */
  async getProduct(orgId: string, productId: number, userId?: string, includeDeleted = false) {
    const showCost = userId ? await this.costVisibility.canSeeCost(orgId, userId) : false;
    const product = await this.db.query.invProducts.findFirst({
      where: and(
        eq(invProducts.id, productId),
        eq(invProducts.orgId, orgId),
        ...(includeDeleted ? [] : [isNull(invProducts.deletedAt)]),
      ),
      with: {
        category: true,
        uom: true,
        variants: true,
        creator: { columns: { id: true, name: true } },
      },
    });
    if (!product) throw new NotFoundException("Product not found");
    return showCost ? product : stripCostFields(product);
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
    await this.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
    return updated;
  }

  /**
   * Removes a product from the catalogue without destroying anything.
   *
   * This used to be a physical DELETE, and inv_stock_transactions.product_variant_id
   * carries ON DELETE CASCADE — so a product that was received and then fully
   * shipped nets to zero on hand, passes the stock guard below, and takes its
   * whole movement history with it, along with its lots, serials, valuation
   * layers and cost history. Proven in a rolled-back transaction: two ledger
   * rows and one lot before, zero of each after.
   *
   * Now it stamps deleted_at, so the ledger is unreachable by this path. The
   * conflict guards stay, because hiding a product that still holds stock or
   * sits on an open order is a mistake worth refusing rather than absorbing.
   */
  async deleteProduct(orgId: string, productId: number, userId: string) {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.invProducts.findFirst({
        where: and(
          eq(invProducts.id, productId),
          eq(invProducts.orgId, orgId),
          isNull(invProducts.deletedAt),
        ),
        columns: { id: true, sku: true, name: true },
      });
      if (!existing) throw new NotFoundException("Product not found");

      const variants = await tx.query.invProductVariants.findMany({
        where: and(
          eq(invProductVariants.productId, productId),
          eq(invProductVariants.orgId, orgId),
          isNull(invProductVariants.deletedAt),
        ),
        columns: { id: true },
      });

      if (variants.length > 0) {
        const variantIds = variants.map((v) => v.id);
        await this.assertNothingDependsOn(tx, orgId, variantIds);
      }

      const deletedAt = new Date();
      await tx
        .update(invProducts)
        .set({ deletedAt })
        .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)));
      await tx
        .update(invProductVariants)
        .set({ deletedAt })
        .where(and(
          eq(invProductVariants.productId, productId),
          eq(invProductVariants.orgId, orgId),
          isNull(invProductVariants.deletedAt),
        ));

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "product.deleted",
        resourceType: "product",
        resourceId: String(productId),
        before: { sku: existing.sku, name: existing.name, deletedAt: null },
        after: { deletedAt: deletedAt.toISOString(), variantsDeleted: variants.length },
      });

      await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
      await this.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
    });
  }

  /**
   * Refuses when the product still holds stock or sits on an open document.
   *
   * The quantity comparison is done in Postgres, not JavaScript: the previous
   * `parseFloat(sum) > 0` read an 18,4 numeric through a float, which is the one
   * arithmetic the PRD forbids outright for stock.
   */
  private async assertNothingDependsOn(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    variantIds: number[],
  ): Promise<void> {
      const [stockRows, openPoLines, openSoLines] = await Promise.all([
        tx
          .select({
            positive: sql<boolean>`COALESCE(SUM(${invStockLevels.onHand}), 0) > 0`,
          })
          .from(invStockLevels)
          .where(and(
            eq(invStockLevels.orgId, orgId),
            inArray(invStockLevels.productVariantId, variantIds),
          )),
        tx
          .select({ id: invPoLines.id })
          .from(invPoLines)
          .innerJoin(
            invPurchaseOrders,
            eq(invPoLines.poId, invPurchaseOrders.id),
          )
          .where(
            and(
              eq(invPurchaseOrders.orgId, orgId),
              inArray(invPoLines.productVariantId, variantIds),
              inArray(invPurchaseOrders.status, ["DRAFT", "SENT", "PARTIAL"]),
            ),
          )
          .limit(1),
        tx
          .select({ id: invSoLines.id })
          .from(invSoLines)
          .innerJoin(invSalesOrders, eq(invSoLines.soId, invSalesOrders.id))
          .where(
            and(
              eq(invSalesOrders.orgId, orgId),
              inArray(invSoLines.productVariantId, variantIds),
              inArray(invSalesOrders.status, ["DRAFT", "CONFIRMED"]),
            ),
          )
          .limit(1),
      ]);

      if (stockRows[0]?.positive === true) {
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

  async archiveProduct(orgId: string, productId: number, userId: string) {
    const existing = await this.db.query.invProducts.findFirst({
      where: and(
        eq(invProducts.id, productId),
        eq(invProducts.orgId, orgId),
        isNull(invProducts.deletedAt),
      ),
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
    await this.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
    return updated;
  }

  /**
   * A4. Bring a product back, from either way it could have gone away.
   *
   * This used to load its row with `deleted_at IS NULL`, so the one state it
   * could not find was the deleted one — a soft-deleted product answered 404 to
   * the endpoint whose entire purpose was to undo that. It also only flipped
   * `status` back to ACTIVE and never cleared `deleted_at`, so even if the row
   * had been found, the product would have stayed invisible to every read (they
   * all filter deleted rows) and to the SKU uniqueness index.
   *
   * Restoring the variants matters as much as the product: `deleteProduct` soft
   * deletes both, and a product whose variants are still deleted is a catalogue
   * entry nobody can order.
   */
  async restoreProduct(orgId: string, productId: number, userId: string) {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.invProducts.findFirst({
        where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
        columns: { id: true, sku: true, status: true, deletedAt: true },
      });
      if (!existing) throw new NotFoundException("Product not found");

      // SKU uniqueness is a partial index over live rows, so a deleted SKU is
      // free for reuse — and frequently reused. Restoring on top of the reuse
      // would fail on the index with a 23505 and a message about a constraint;
      // this says what actually happened.
      if (existing.deletedAt !== null) {
        const clash = await tx.query.invProducts.findFirst({
          where: and(
            eq(invProducts.orgId, orgId),
            eq(invProducts.sku, existing.sku),
            isNull(invProducts.deletedAt),
          ),
          columns: { id: true },
        });
        if (clash && clash.id !== productId) {
          throw new ConflictException(
            `SKU ${existing.sku} now belongs to another product. Change that product's SKU, or give this one a new SKU, before restoring it.`,
          );
        }
      }

      const restoredVariants = await tx
        .update(invProductVariants)
        .set({ deletedAt: null })
        .where(and(
          eq(invProductVariants.productId, productId),
          eq(invProductVariants.orgId, orgId),
          isNotNull(invProductVariants.deletedAt),
        ))
        .returning({ id: invProductVariants.id });

      const [updated] = await tx
        .update(invProducts)
        .set({ status: "ACTIVE", deletedAt: null, updatedAt: new Date() })
        .where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)))
        .returning();

      await this.audit.insert(tx, {
        orgId,
        actorUserId: userId,
        action: "product.restore",
        resourceType: "product",
        resourceId: String(productId),
        before: {
          status: existing.status,
          deletedAt: existing.deletedAt?.toISOString() ?? null,
        },
        after: { status: "ACTIVE", deletedAt: null, variantsRestored: restoredVariants.length },
      });

      await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
      await this.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
      return updated;
    });
  }
}
