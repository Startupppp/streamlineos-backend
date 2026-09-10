import { NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { invProducts } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../../common/cache/cache-keys";
import { applyScope } from "../../../access/apply-scope";
import type { DataScope } from "../../../access/access.types";
import { CostVisibilityService, stripCostFields } from "../../stock-engine/cost-visibility";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { packVisibility, stripProductPackFields } from "./product-pack-visibility";
import type { ListProductsInput } from "../dto/inv-products.schemas";

export interface ProductReadDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly costVisibility: CostVisibilityService;
  readonly settings: InventorySettingsService;
}

export async function listProducts(
  deps: ProductReadDeps,
  orgId: string,
  filters: ListProductsInput,
  scope: DataScope = "all",
  userId?: string,
) {
  if (scope === "none")
    return { items: [], total: 0, page: filters.page, totalPages: 0 };

  const { status, productType, categoryId, search, page, limit, includeDeleted } = filters;
  // B1. Ignored rather than refused while the pack is off: a stale bookmark
  // carrying `?brand=…` should show the catalogue, not an error, and with the
  // pack off no row carries a brand so the filter would empty the list.
  const brand = filters.brand;
  const materialFamily = filters.materialFamily;
  const offset = (page - 1) * limit;
  // Cost visibility is part of the key: this list is cached per org, so a
  // masked payload must not be served to a cost-permitted caller or vice versa.
  const showCost = userId ? await deps.costVisibility.canSeeCost(orgId, userId) : false;
  // E1. The pack is part of the key, not a post-filter on a shared entry: this
  // list is cached per org, so one payload cannot be both the version that
  // carries HSN and the version that does not. Keying it also means turning the
  // pack on needs no cross-module cache invalidation from settings.
  // E1. The packs are part of the key, not a post-filter on a shared entry:
  // this list is cached per org, so one payload cannot be both the version that
  // carries HSN and the version that does not. Keying them also means turning a
  // pack on needs no cross-module cache invalidation from settings.
  const packs = await packVisibility(deps, orgId);
  const packKey = `${packs.gst ? "gst" : "nogst"}:${packs.pharmacy ? "rx" : "norx"}:${packs.kirana ? "kir" : "nokir"}:${packs.materials ? "mat" : "nomat"}`;
  const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
  // §6: every filter that changes the result is in the key, or one caller's
  // narrowed page is served to the next as if it were the whole catalogue.
  const materialsKey = packs.materials ? `${brand ?? ""}:${materialFamily ?? ""}` : "";
  const hash = `${showCost ? "cost" : "nocost"}:${packKey}:${status ?? ""}:${productType ?? ""}:${categoryId ?? ""}:${search ?? ""}:${materialsKey}:${includeDeleted ? "withdeleted" : "live"}:${limit}:${offset}${scopeSuffix}`;
  return deps.cache.cachedVersioned(
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
      if (packs.materials && brand) conditions.push(eq(invProducts.brand, brand));
      if (packs.materials && materialFamily)
        conditions.push(eq(invProducts.materialFamily, materialFamily));
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
        deps.db.query.invProducts.findMany({
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
        deps.db
          .select({ count: sql<number>`count(*)::int` })
          .from(invProducts)
          .where(where),
      ]);

      const visible = showCost ? items : stripCostFields(items);
      return {
        items: stripProductPackFields(visible, packs),
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
export async function getProduct(deps: ProductReadDeps, orgId: string, productId: number, userId?: string, includeDeleted = false) {
  const showCost = userId ? await deps.costVisibility.canSeeCost(orgId, userId) : false;
  const packs = await packVisibility(deps, orgId);
  const product = await deps.db.query.invProducts.findFirst({
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
  const visible = showCost ? product : stripCostFields(product);
  return stripProductPackFields(visible, packs);
}
