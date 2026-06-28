import { Inject, Injectable, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, ilike, or, asc, desc, sql } from "drizzle-orm";
import { invProducts, invProductVariants, invCategories, invUom } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import type { CreateProductInput, UpdateProductInput, ListProductsInput, CreateVariantInput, UpdateVariantInput, CreateCategoryInput, CreateUomInput } from "./dto/inv-products.schemas";

@Injectable()
export class InvProductsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async listProducts(orgId: string, filters: ListProductsInput, scope: DataScope = "all", userId?: string) {
    if (scope === "none") return { items: [], total: 0, page: filters.page, totalPages: 0 };

    const { status, categoryId, search, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
    const hash = `${status ?? ""}:${categoryId ?? ""}:${search ?? ""}:${limit}:${offset}${scopeSuffix}`;
    const key = CACHE_KEYS.invProductsList(orgId, hash);

    return this.cache.cached(key, async () => {
      const conditions = [eq(invProducts.orgId, orgId)];
      if (status) conditions.push(eq(invProducts.status, status));
      if (categoryId) conditions.push(eq(invProducts.categoryId, categoryId));
      if (search) {
        conditions.push(or(
          ilike(invProducts.name, `%${search}%`),
          ilike(invProducts.sku, `%${search}%`),
        )!);
      }
      if (scope !== "all" && userId) {
        conditions.push(applyScope(scope, userId, { ownerColumn: invProducts.createdBy }));
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
            variants: { columns: { id: true, sku: true, name: true, isActive: true } },
          },
        }),
        this.db.select({ count: sql<number>`count(*)::int` }).from(invProducts).where(where),
      ]);

      return { items, total: countResult[0]?.count ?? 0, page, totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit) };
    }, CACHE_TTL.SHORT);
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

  async createProduct(orgId: string, userId: string, data: CreateProductInput) {
    const existing = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.orgId, orgId), eq(invProducts.sku, data.sku)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A product with this SKU already exists");

    const [product] = await this.db.insert(invProducts).values({
      orgId,
      createdBy: userId,
      ...data,
    }).returning();

    if (!data.hasVariants) {
      await this.db.insert(invProductVariants).values({
        orgId,
        productId: product.id,
        name: data.name,
        sku: data.sku,
        barcode: data.barcode,
        costPrice: data.costPrice ?? "0",
        sellingPrice: data.sellingPrice ?? "0",
        attributeValues: {},
      });
    }

    await this.cache.invalidatePattern(`inv:products:list:${orgId}:*`);
    return product;
  }

  async updateProduct(orgId: string, productId: number, data: UpdateProductInput) {
    const existing = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Product not found");

    const [updated] = await this.db.update(invProducts)
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

    await this.db.delete(invProducts).where(and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)));
    await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
    await this.cache.invalidatePattern(`inv:products:list:${orgId}:*`);
  }

  async createVariant(orgId: string, productId: number, data: CreateVariantInput) {
    const product = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true },
    });
    if (!product) throw new NotFoundException("Product not found");

    const existing = await this.db.query.invProductVariants.findFirst({
      where: and(eq(invProductVariants.orgId, orgId), eq(invProductVariants.sku, data.sku)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A variant with this SKU already exists");

    const [variant] = await this.db.insert(invProductVariants).values({ orgId, productId, ...data }).returning();
    await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
    return variant;
  }

  async updateVariant(orgId: string, variantId: number, data: UpdateVariantInput) {
    const [updated] = await this.db.update(invProductVariants)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(invProductVariants.id, variantId), eq(invProductVariants.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Variant not found");
    return updated;
  }

  listVariants(orgId: string, filters: { activeOnly: boolean; page: number; limit: number }) {
    const { activeOnly, page, limit } = filters;
    const offset = (page - 1) * limit;
    const conditions = [eq(invProductVariants.orgId, orgId)];
    if (activeOnly) conditions.push(eq(invProductVariants.isActive, true));
    return this.db
      .select({
        id: invProductVariants.id,
        productId: invProductVariants.productId,
        productName: invProducts.name,
        name: invProductVariants.name,
        sku: invProductVariants.sku,
        costPrice: invProductVariants.costPrice,
        isActive: invProductVariants.isActive,
      })
      .from(invProductVariants)
      .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
      .where(and(...conditions))
      .orderBy(asc(invProducts.name), asc(invProductVariants.name))
      .limit(limit)
      .offset(offset);
  }

  listCategories(orgId: string) {
    return this.cache.cached(`inv:products:categories:${orgId}`, () =>
      this.db.query.invCategories.findMany({ where: eq(invCategories.orgId, orgId), orderBy: [asc(invCategories.name)] }),
      CACHE_TTL.MEDIUM
    );
  }

  async createCategory(orgId: string, data: CreateCategoryInput) {
    const [cat] = await this.db.insert(invCategories).values({ orgId, ...data }).returning();
    await this.cache.del(`inv:products:categories:${orgId}`);
    return cat;
  }

  listUom(orgId: string) {
    return this.cache.cached(`inv:products:uom:${orgId}`, () =>
      this.db.query.invUom.findMany({ where: eq(invUom.orgId, orgId), orderBy: [asc(invUom.name)] }),
      CACHE_TTL.MEDIUM
    );
  }

  async createUom(orgId: string, data: CreateUomInput) {
    const [uom] = await this.db.insert(invUom).values({ orgId, ...data }).returning();
    await this.cache.del(`inv:products:uom:${orgId}`);
    return uom;
  }
}
