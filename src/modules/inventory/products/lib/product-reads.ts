import { NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { invProducts } from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../../common/cache/cache-keys";
import { ScopedRead } from "../../../access/scoped-read";
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
  read: ScopedRead,
  filters: ListProductsInput,
) {
  const { status, productType, categoryId, search, page, limit, includeDeleted } = filters;
  if (read.denied) return { items: [], total: 0, page, totalPages: 0 };

  const orgId = read.orgId;
  // B1. Ignored rather than refused while the pack is off: a stale bookmark
  // carrying `?brand=…` should show the catalogue, not an error, and with the
  // pack off no row carries a brand so the filter would empty the list.
  const brand = filters.brand;
  const materialFamily = filters.materialFamily;
  const offset = (page - 1) * limit;
  // Cost visibility is part of the key: this list is cached per org, so a
  // masked payload must not be served to a cost-permitted caller or vice versa.
  const showCost = await deps.costVisibility.canSeeCost(orgId, read.actorId);
  // E1. The packs are part of the key, not a post-filter on a shared entry:
  // this list is cached per org, so one payload cannot be both the version that
  // carries HSN and the version that does not. Keying them also means turning a
  // pack on needs no cross-module cache invalidation from settings.
  const packs = await packVisibility(deps, orgId);
  const packKey = `${packs.gst ? "gst" : "nogst"}:${packs.pharmacy ? "rx" : "norx"}:${packs.kirana ? "kir" : "nokir"}:${packs.materials ? "mat" : "nomat"}`;
  // §6: every filter that changes the result is in the key, or one caller's
  // narrowed page is served to the next as if it were the whole catalogue.
  const materialsKey = packs.materials ? `${brand ?? ""}:${materialFamily ?? ""}` : "";
  const hash = `${showCost ? "cost" : "nocost"}:${packKey}:${status ?? ""}:${productType ?? ""}:${categoryId ?? ""}:${search ?? ""}:${materialsKey}:${includeDeleted ? "withdeleted" : "live"}:${limit}:${offset}:${read.discriminator}`;
  return deps.cache.cachedVersioned(
    CACHE_KEYS.invProductsNamespace(orgId),
    hash,
    () =>
      read.read(
        {
          tenant: invProducts.orgId,
          scope: { columns: { ownerColumn: invProducts.createdBy } },
          and: [
            // A deleted product must not come back through a list unless the caller
            // asked for it. The partial index on (org_id, id) WHERE deleted_at IS
            // NULL covers the default predicate.
            includeDeleted ? undefined : isNull(invProducts.deletedAt),
            status ? eq(invProducts.status, status) : undefined,
            productType ? eq(invProducts.productType, productType) : undefined,
            categoryId ? eq(invProducts.categoryId, categoryId) : undefined,
            packs.materials && brand ? eq(invProducts.brand, brand) : undefined,
            packs.materials && materialFamily ? eq(invProducts.materialFamily, materialFamily) : undefined,
            search
              ? or(
                  ilike(invProducts.name, `%${search}%`),
                  ilike(invProducts.sku, `%${search}%`),
                )
              : undefined,
          ],
        },
        async ({ sql: where }) => {
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
        () => ({ items: [], total: 0, page, totalPages: 0 }),
      ),
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
