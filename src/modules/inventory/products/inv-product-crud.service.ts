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
  invProductUomConversions,
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
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { CostVisibilityService, stripCostFields } from "../stock-engine/cost-visibility";
import {
  PRODUCT_TAX_FIELD_KEYS,
  PRODUCT_PHARMACY_FIELD_KEYS,
  PRODUCT_KIRANA_FIELD_KEYS,
  PRODUCT_MATERIALS_FIELD_KEYS,
} from "./dto/inv-products.schemas";
import { assertCaptureRulesCoherent, assertUnitConvertible, PACKED_WHOLE } from "./lib/quantity-capture";
import type {
  CreateProductInput,
  UpdateProductInput,
  ListProductsInput,
} from "./dto/inv-products.schemas";

const TAX_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_TAX_FIELD_KEYS);
const PHARMACY_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_PHARMACY_FIELD_KEYS);
const KIRANA_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_KIRANA_FIELD_KEYS);
const MATERIALS_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_MATERIALS_FIELD_KEYS);

/**
 * E1/E2/E3/E4. Removes a pack's fields from a payload, at any nesting depth.
 *
 * Stripped from the response rather than hidden in the UI, for the same reason
 * cost fields are: a distributor that does not run the `gst` pack must not
 * receive an `hsnCode: null` it then has to explain, a warehouse must not
 * receive a `drugSchedule`, and a client that never sees a field cannot start
 * depending on it. Same shape as `stripCostFields` deliberately — one idea, now
 * four gates.
 */
function stripKeys(value: unknown, hidden: ReadonlySet<string>, depth: number): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, hidden, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (hidden.has(key)) continue;
    out[key] = stripKeys(inner, hidden, depth + 1);
  }
  return out;
}

/**
 * Which packs are on, in the one shape the list cache key and every stripper
 * read. Carried together so a caller cannot strip for one pack and key for
 * another — that mismatch is invisible until a cached payload is served to the
 * wrong organisation's screen.
 */
export interface ProductPackVisibility {
  gst: boolean;
  pharmacy: boolean;
  kirana: boolean;
  materials: boolean;
}

export function stripProductPackFields<T>(payload: T, visible: ProductPackVisibility): T {
  let out = payload;
  if (!visible.gst) out = stripKeys(out, TAX_FIELD_SET, 0) as T;
  if (!visible.pharmacy) out = stripKeys(out, PHARMACY_FIELD_SET, 0) as T;
  if (!visible.kirana) out = stripKeys(out, KIRANA_FIELD_SET, 0) as T;
  if (!visible.materials) out = stripKeys(out, MATERIALS_FIELD_SET, 0) as T;
  return out;
}

@Injectable()
export class InvProductCrudService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: InventoryAuditService,
    private readonly costVisibility: CostVisibilityService,
    private readonly settings: InventorySettingsService,
  ) {}

  /**
   * E1 — the pack flag, doing something.
   *
   * With the `gst` pack off there is no HSN field on the form, no HSN column in
   * the response, and no way to write one through the API either. A gate that
   * only hides the field leaves the column writable by anyone who has read the
   * network tab, and then the organisation has classification data it cannot see
   * or correct.
   */
  private async assertPacksForFields(
    orgId: string,
    data: CreateProductInput | UpdateProductInput,
  ): Promise<void> {
    const gates = [
      { keys: PRODUCT_TAX_FIELD_KEYS, on: "gst", code: "GST_PACK_DISABLED", label: "GST" },
      { keys: PRODUCT_PHARMACY_FIELD_KEYS, on: "pharmacy", code: "PHARMACY_PACK_DISABLED", label: "pharmacy" },
      { keys: PRODUCT_KIRANA_FIELD_KEYS, on: "kirana", code: "KIRANA_PACK_DISABLED", label: "kirana" },
      { keys: PRODUCT_MATERIALS_FIELD_KEYS, on: "materials", code: "MATERIALS_PACK_DISABLED", label: "materials" },
    ] as const;
    const touched = gates
      .map((gate) => ({ gate, supplied: gate.keys.filter((key) => key in data) }))
      .filter(({ supplied }) => supplied.length > 0);
    if (touched.length === 0) return;

    const settings = await this.settings.get(orgId);
    for (const { gate, supplied } of touched) {
      if (settings.packs[gate.on]) continue;
      throw new BadRequestException({
        code: gate.code,
        message: `The ${gate.label} pack is not enabled for this organisation, so ${supplied.join(", ")} cannot be set. Enable it in inventory settings first.`,
      });
    }
  }

  private async packVisibility(orgId: string): Promise<ProductPackVisibility> {
    const settings = await this.settings.get(orgId);
    return {
      gst: settings.packs.gst,
      pharmacy: settings.packs.pharmacy,
      kirana: settings.packs.kirana,
      materials: settings.packs.materials,
    };
  }

  /**
   * E4. The entry contract has to stay coherent whichever half of it the patch
   * touched — a request that sets `saleMode: "LOOSE"` and nothing else has to be
   * checked against the modes already stored, not against its own two keys.
   */
  private async assertCaptureConfig(
    orgId: string,
    productId: number | null,
    data: CreateProductInput | UpdateProductInput,
  ): Promise<void> {
    const touched = PRODUCT_KIRANA_FIELD_KEYS.some((key) => key in data);
    if (!touched) return;

    const stored = productId
      ? await this.db.query.invProducts.findFirst({
          where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
          columns: {
            saleMode: true, quantityInputMode: true, quantityPrecision: true,
            uomId: true, salesUomId: true,
          },
        })
      : null;

    const saleMode = data.saleMode ?? stored?.saleMode ?? PACKED_WHOLE.saleMode;
    assertCaptureRulesCoherent({
      saleMode,
      inputMode: data.quantityInputMode ?? stored?.quantityInputMode ?? PACKED_WHOLE.inputMode,
      precision: data.quantityPrecision ?? stored?.quantityPrecision ?? PACKED_WHOLE.precision,
    });

    // A loose SKU that sells in a unit other than the one it is stocked in needs
    // the factor between them, or every sale of 500 g removes 500 kg. Checked
    // before the write, against the state the patch would leave behind — and only
    // where the product already exists, because a product and its conversion rows
    // cannot be written in one request.
    if (saleMode !== "LOOSE" || !productId) return;
    const uomId = data.uomId ?? stored?.uomId ?? null;
    const salesUomId = data.salesUomId ?? stored?.salesUomId ?? null;
    if (salesUomId === null || salesUomId === uomId) return;

    const [unit, conversion] = await Promise.all([
      this.db.query.invUom.findFirst({
        where: and(eq(invUom.id, salesUomId), eq(invUom.orgId, orgId)),
        columns: { abbreviation: true },
      }),
      this.db.query.invProductUomConversions.findFirst({
        where: and(
          eq(invProductUomConversions.orgId, orgId),
          eq(invProductUomConversions.productId, productId),
          eq(invProductUomConversions.uomId, salesUomId),
        ),
        columns: { uomId: true },
      }),
    ]);
    assertUnitConvertible(unit?.abbreviation ?? `unit ${salesUomId}`, "salesUomId", Boolean(conversion));
  }

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
    // B1. Ignored rather than refused while the pack is off: a stale bookmark
    // carrying `?brand=…` should show the catalogue, not an error, and with the
    // pack off no row carries a brand so the filter would empty the list.
    const brand = filters.brand;
    const materialFamily = filters.materialFamily;
    const offset = (page - 1) * limit;
    // Cost visibility is part of the key: this list is cached per org, so a
    // masked payload must not be served to a cost-permitted caller or vice versa.
    const showCost = userId ? await this.costVisibility.canSeeCost(orgId, userId) : false;
    // E1. The pack is part of the key, not a post-filter on a shared entry: this
    // list is cached per org, so one payload cannot be both the version that
    // carries HSN and the version that does not. Keying it also means turning the
    // pack on needs no cross-module cache invalidation from settings.
    // E1. The packs are part of the key, not a post-filter on a shared entry:
    // this list is cached per org, so one payload cannot be both the version that
    // carries HSN and the version that does not. Keying them also means turning a
    // pack on needs no cross-module cache invalidation from settings.
    const packs = await this.packVisibility(orgId);
    const packKey = `${packs.gst ? "gst" : "nogst"}:${packs.pharmacy ? "rx" : "norx"}:${packs.kirana ? "kir" : "nokir"}:${packs.materials ? "mat" : "nomat"}`;
    const scopeSuffix = scope !== "all" ? `:${scope}:${userId ?? ""}` : "";
    // §6: every filter that changes the result is in the key, or one caller's
    // narrowed page is served to the next as if it were the whole catalogue.
    const materialsKey = packs.materials ? `${brand ?? ""}:${materialFamily ?? ""}` : "";
    const hash = `${showCost ? "cost" : "nocost"}:${packKey}:${status ?? ""}:${productType ?? ""}:${categoryId ?? ""}:${search ?? ""}:${materialsKey}:${includeDeleted ? "withdeleted" : "live"}:${limit}:${offset}${scopeSuffix}`;
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
  async getProduct(orgId: string, productId: number, userId?: string, includeDeleted = false) {
    const showCost = userId ? await this.costVisibility.canSeeCost(orgId, userId) : false;
    const packs = await this.packVisibility(orgId);
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
    const visible = showCost ? product : stripCostFields(product);
    return stripProductPackFields(visible, packs);
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
    await this.assertPacksForFields(orgId, data);
    await this.assertCaptureConfig(orgId, null, data);
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
    await this.assertPacksForFields(orgId, data);
    await this.assertCaptureConfig(orgId, productId, data);
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
   *
   * B2. Restore used to write `status: "ACTIVE"` unconditionally, which made it
   * a laundry for the A4 demand gate: discontinue a SKU, sell it to zero, delete
   * it, restore it, and it is orderable again in two clicks that neither asked
   * for nor recorded a decision to un-retire it. So restore now undoes exactly
   * one step, and never invents a status it did not itself set:
   *
   *   - a soft-deleted row is un-deleted and keeps the status it had. Nothing
   *     had to be remembered for this: `deleteProduct` writes only `deleted_at`,
   *     so the `status` column already *is* the pre-delete state.
   *   - an archived row (INACTIVE, which is the only status `archiveProduct`
   *     writes) goes back to ACTIVE, because that pair is what the Restore
   *     control means on a product that is merely archived.
   *   - DISCONTINUED is never lifted here. Retiring a SKU is a decision, and
   *     its inverse is the same deliberate edit that made it — `updateProduct`
   *     takes `status` — not a button labelled "Restore".
   *
   * Archive-then-delete therefore takes two restores to get back to ACTIVE, one
   * per step, which is the point.
   */
  async restoreProduct(orgId: string, productId: number, userId: string) {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.invProducts.findFirst({
        where: and(eq(invProducts.id, productId), eq(invProducts.orgId, orgId)),
        columns: { id: true, sku: true, status: true, deletedAt: true },
      });
      if (!existing) throw new NotFoundException("Product not found");

      if (existing.deletedAt !== null) {
        await this.assertRestorableSkus(tx, orgId, productId, existing.sku);
      }

      // Un-deleting restores the row as it stood; only an archive is lifted.
      const status =
        existing.deletedAt === null && existing.status === "INACTIVE"
          ? "ACTIVE"
          : existing.status;

      // B1. The pre-checks above name the SKU that is in the way, but they are
      // still a read followed by a write: two concurrent restores, or two
      // deleted variants of this product that were given the same SKU while
      // both were deleted, reach the partial unique indexes anyway. An
      // unhandled 23505 is a 500 on an endpoint that has a 409 to give.
      try {
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
          .set({ status, deletedAt: null, updatedAt: new Date() })
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
          after: { status, deletedAt: null, variantsRestored: restoredVariants.length },
        });

        await this.cache.del(CACHE_KEYS.invProductDetail(orgId, productId));
        await this.cache.invalidateNamespace(CACHE_KEYS.invProductsNamespace(orgId));
        return updated;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            "One of this product's SKUs has been taken since it was deleted. Change the SKU that now holds it, or give this product's SKU a new value, before restoring it.",
          );
        }
        throw err;
      }
    });
  }

  /**
   * Both live-SKU indexes, checked before the restore rather than after.
   *
   * SKU uniqueness is a partial index over live rows on each of `inv_products`
   * and `inv_product_variants`, so a deleted SKU is free for reuse — and reuse
   * is normally *why* the product was deleted. The product-level check has
   * always been here; the variant-level one was not, and the variants are
   * cleared with no check at all, so the ordinary sequence "delete P, create Q
   * reusing P's variant SKU, restore P" hit `uniq_inv_product_variants_org_sku_live`
   * and came back a 500 from an endpoint standing right next to a friendly 409.
   */
  private async assertRestorableSkus(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    orgId: string,
    productId: number,
    productSku: string,
  ): Promise<void> {
    const clash = await tx.query.invProducts.findFirst({
      where: and(
        eq(invProducts.orgId, orgId),
        eq(invProducts.sku, productSku),
        isNull(invProducts.deletedAt),
      ),
      columns: { id: true },
    });
    if (clash && clash.id !== productId) {
      throw new ConflictException(
        `SKU ${productSku} now belongs to another product. Change that product's SKU, or give this one a new SKU, before restoring it.`,
      );
    }

    const deletedVariants = await tx.query.invProductVariants.findMany({
      where: and(
        eq(invProductVariants.productId, productId),
        eq(invProductVariants.orgId, orgId),
        isNotNull(invProductVariants.deletedAt),
      ),
      columns: { sku: true },
    });
    if (deletedVariants.length === 0) return;

    const takenRows = await tx
      .select({ sku: invProductVariants.sku })
      .from(invProductVariants)
      .where(and(
        eq(invProductVariants.orgId, orgId),
        inArray(invProductVariants.sku, deletedVariants.map((v) => v.sku)),
        isNull(invProductVariants.deletedAt),
      ));
    if (takenRows.length > 0) {
      const taken = [...new Set(takenRows.map((row) => row.sku))].sort();
      throw new ConflictException(
        `Variant SKU ${taken.join(", ")} now belongs to another product. Change that variant's SKU, or give this product's variants new SKUs, before restoring it.`,
      );
    }
  }
}
