import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, asc, ne } from "drizzle-orm";
import { assertNoBarcodeConflict } from "./lib/barcode-conflict";
import {
  invProducts,
  invProductVariants,
  invCategories,
  invUom,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  CreateVariantInput,
  UpdateVariantInput,
  CreateCategoryInput,
  CreateUomInput,
  UpdateCategoryInput,
  UpdateUomInput,
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
export class InvProductCatalogService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async createVariant(
    orgId: string,
    productId: number,
    data: CreateVariantInput,
  ) {
    const product = await this.db.query.invProducts.findFirst({
      where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
      columns: { id: true },
    });
    if (!product) throw new NotFoundException("Product not found");

    if (data.barcode) await assertNoBarcodeConflict(this.db, orgId, data.barcode);

    try {
      const [variant] = await this.db
        .insert(invProductVariants)
        .values({ orgId, productId, ...data })
        .returning();
      await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
      return variant;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException("A variant with this SKU already exists");
      }
      throw err;
    }
  }

  async updateVariant(
    orgId: string,
    variantId: number,
    data: UpdateVariantInput,
  ) {
    if (data.barcode) {
      await assertNoBarcodeConflict(this.db, 
        orgId,
        data.barcode,
        undefined,
        variantId,
      );
    }

    const [updated] = await this.db
      .update(invProductVariants)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(invProductVariants.id, variantId),
          eq(invProductVariants.orgId, orgId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Variant not found");
    return updated;
  }

  listVariants(
    orgId: string,
    filters: { activeOnly: boolean; page: number; limit: number },
  ) {
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
    return this.cache.cached(
      `inv:products:categories:${orgId}`,
      () =>
        this.db.query.invCategories.findMany({
          where: eq(invCategories.orgId, orgId),
          orderBy: [asc(invCategories.name)],
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  async createCategory(orgId: string, data: CreateCategoryInput) {
    try {
      const [cat] = await this.db
        .insert(invCategories)
        .values({ orgId, ...data })
        .returning();
      await this.cache.del(`inv:products:categories:${orgId}`);
      return cat;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException("A category with this name already exists");
      }
      throw err;
    }
  }

  async updateCategory(
    orgId: string,
    categoryId: number,
    data: UpdateCategoryInput,
  ) {
    try {
      const [updated] = await this.db
        .update(invCategories)
        .set({ ...data })
        .where(
          and(
            eq(invCategories.id, categoryId),
            eq(invCategories.orgId, orgId),
          ),
        )
        .returning();
      if (!updated) throw new NotFoundException("Category not found");
      await this.cache.del(`inv:products:categories:${orgId}`);
      return updated;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException("A category with this name already exists");
      }
      throw err;
    }
  }

  listUom(orgId: string) {
    return this.cache.cached(
      `inv:products:uom:${orgId}`,
      () =>
        this.db.query.invUom.findMany({
          where: eq(invUom.orgId, orgId),
          orderBy: [asc(invUom.name)],
        }),
      CACHE_TTL.MEDIUM,
    );
  }

  async createUom(orgId: string, data: CreateUomInput) {
    const uom = await this.db.transaction(async (tx) => {
      if (data.isBase && data.category) {
        await tx
          .update(invUom)
          .set({ isBase: false })
          .where(
            and(
              eq(invUom.orgId, orgId),
              eq(invUom.category, data.category),
              eq(invUom.isBase, true),
            ),
          );
      }
      const [inserted] = await tx
        .insert(invUom)
        .values({ orgId, ...data })
        .returning();
      return inserted;
    });
    await this.cache.del(`inv:products:uom:${orgId}`);
    return uom;
  }

  async updateUom(orgId: string, uomId: number, data: UpdateUomInput) {
    const updated = await this.db.transaction(async (tx) => {
      if (data.isBase) {
        const existingUom = await tx.query.invUom.findFirst({
          where: and(eq(invUom.id, uomId), eq(invUom.orgId, orgId)),
          columns: { category: true },
        });
        if (!existingUom) throw new NotFoundException("UOM not found");
        const effectiveCategory = data.category ?? existingUom.category;
        if (effectiveCategory) {
          await tx
            .update(invUom)
            .set({ isBase: false })
            .where(
              and(
                eq(invUom.orgId, orgId),
                eq(invUom.category, effectiveCategory),
                eq(invUom.isBase, true),
                ne(invUom.id, uomId),
              ),
            );
        }
      }

      const [result] = await tx
        .update(invUom)
        .set({ ...data })
        .where(and(eq(invUom.id, uomId), eq(invUom.orgId, orgId)))
        .returning();
      if (!result) throw new NotFoundException("UOM not found");
      return result;
    });
    await this.cache.del(`inv:products:uom:${orgId}`);
    return updated;
  }
}
