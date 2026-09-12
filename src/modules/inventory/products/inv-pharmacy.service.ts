import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { invLots, invProducts, invProductVariants } from "../../../db/schema";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import {
  assertReceiptLine,
  resolveDispensingSafety,
  resolveReceiptRequirements,
  type ConfusableSku,
  type DispensingSafety,
  type PharmacyClassification,
  type ReceiptLineFacts,
  type ReceiptRequirements,
} from "./lib/pharmacy";
import type { H1RegisterQuery } from "./dto/inv-products.schemas";

/**
 * E3 — the pharmacy pack's one answer about a SKU.
 *
 * Everything that decides what a pharmacy may do with a product is here, for the
 * same reason `InvTaxTreatmentService` exists: a receiving screen, a picking
 * screen and a receipt-post transaction asking the same question must not be
 * able to get different answers. Three copies of "does this SKU need an MRP"
 * stay equal until one is edited.
 *
 * Every method short-circuits when the pack is off, without reading the SKU. A
 * gate that still costs a join is a gate somebody removes for being slow.
 */
@Injectable()
export class InvPharmacyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: InventorySettingsService,
  ) {}

  /** How many confusable siblings a warning will name before it stops being readable. */
  private static readonly MAX_CONFUSABLE = 8;
  /** How many batches the counter is shown. Beyond this the answer is a report, not a warning. */
  private static readonly MAX_BATCHES = 20;

  async packEnabled(orgId: string): Promise<boolean> {
    const settings = await this.settings.get(orgId);
    return settings.packs.pharmacy;
  }

  /**
   * What the person holding the pack needs to know, at the moment they are
   * holding it: the warnings, what this product is confusable with, and what
   * each batch on the shelf is allowed to be sold for.
   *
   * One call rather than three, because it answers one question — and because a
   * safety warning that costs an extra round-trip at the counter is a warning
   * somebody moves off the pick path.
   */
  async dispensingProfile(orgId: string, productVariantId: number): Promise<{
    packEnabled: boolean;
    productId: number;
    classification: PharmacyClassification | null;
    safety: DispensingSafety;
    confusableWith: ConfusableSku[];
    /** Each batch with the MRP printed on *its* packs. See `inv_lots.mrp_paise`. */
    batches: Array<{ lotId: number; lotNumber: string; expiryDate: string | null; status: string; mrpPaise: number | null }>;
  }> {
    const enabled = await this.packEnabled(orgId);
    const loaded = await this.loadClassification(orgId, productVariantId);

    if (!enabled) {
      return {
        packEnabled: false,
        productId: loaded.productId,
        classification: null,
        safety: { alerts: [], blocksDispense: false, acknowledgementRequired: false },
        confusableWith: [],
        batches: [],
      };
    }

    const [confusableWith, batches] = await Promise.all([
      this.loadConfusable(orgId, loaded.productId, loaded.classification.lasaGroup),
      this.loadBatches(orgId, productVariantId),
    ]);

    return {
      packEnabled: true,
      productId: loaded.productId,
      classification: loaded.classification,
      safety: resolveDispensingSafety(loaded.classification, confusableWith),
      confusableWith,
      batches,
    };
  }

  /**
   * What a receipt line for this SKU has to carry. Read by the receiving screen
   * so the operator is told at the door rather than at post, and by
   * `assertReceiptLine` below so the two cannot disagree.
   */
  async receiptRequirements(orgId: string, productVariantId: number): Promise<ReceiptRequirements> {
    const enabled = await this.packEnabled(orgId);
    const loaded = await this.loadClassification(orgId, productVariantId);
    return resolveReceiptRequirements(enabled ? loaded.classification : null);
  }

  /**
   * The receipt gate, for the module that posts receipts to call.
   *
   * Lives here because the rule is a property of the SKU, and refuses rather
   * than warns because every refusal is about information that stops existing
   * once the delivery is put away — see `lib/pharmacy.ts`.
   */
  async assertReceiptLine(
    orgId: string,
    productVariantId: number,
    line: ReceiptLineFacts,
  ): Promise<void> {
    const enabled = await this.packEnabled(orgId);
    if (!enabled) return;
    const loaded = await this.loadClassification(orgId, productVariantId);
    assertReceiptLine(loaded.classification, line, `${loaded.name} (${loaded.sku})`);
  }

  /**
   * E3 — the Schedule H1 register export, and it is a stub.
   *
   * A statutory H1 register records each supply against the prescriber, the
   * patient and the quantity dispensed. Inventory records stock movements. It
   * does not hold a prescriber, it does not hold a patient, and no amount of
   * shaping the output makes those appear — so this returns the register's
   * **scope**, which is the part inventory genuinely knows, and says plainly
   * that the dispensing rows are not here.
   *
   * Behind its own jurisdiction flag rather than the pharmacy pack, default off:
   * a register that appears uninvited reads as a claim that the system keeps one.
   */
  async h1Register(orgId: string, query: H1RegisterQuery) {
    const settings = await this.settings.get(orgId);
    if (!settings.packs.pharmacy) {
      return {
        enabled: false,
        reason: "PHARMACY_PACK_DISABLED" as const,
        message: "The pharmacy pack is not enabled for this organisation, so no product carries a drug schedule.",
      };
    }
    if (!settings.pharmacyH1RegisterEnabled) {
      return {
        enabled: false,
        reason: "H1_REGISTER_DISABLED" as const,
        message:
          "The Schedule H1 register export is off. Turn it on in inventory settings only if this organisation's jurisdiction requires the register — enabling it does not make StreamlineOS keep one.",
      };
    }

    const offset = (query.page - 1) * query.limit;
    const where = and(
      eq(invProducts.orgId, orgId),
      isNull(invProducts.deletedAt),
      eq(invProducts.drugSchedule, "H1"),
    );

    const [items, countRows] = await Promise.all([
      this.db
        .select({
          productId: invProducts.id,
          sku: invProducts.sku,
          name: invProducts.name,
          drugSchedule: invProducts.drugSchedule,
          mrpPaise: invProducts.mrpPaise,
        })
        .from(invProducts)
        .where(where)
        .orderBy(asc(invProducts.sku))
        .limit(query.limit)
        .offset(offset),
      this.db.select({ count: sql<number>`count(*)::int` }).from(invProducts).where(where),
    ]);

    const total = countRows[0]?.count ?? 0;
    return {
      enabled: true,
      format: "H1_REGISTER_SCOPE_V0" as const,
      generatedAt: new Date().toISOString(),
      /**
       * Stated in the payload, not only in a doc comment. A caller that
       * serialises this into something an inspector reads has to be told by the
       * data itself that it is not a return.
       */
      authoritative: false,
      disclaimer:
        "Scope only. StreamlineOS records stock movements, not dispensings against a prescriber and a patient, and therefore cannot produce a Schedule H1 register. This lists the Schedule H1 products in the catalogue so the register kept elsewhere can be reconciled against them.",
      dispensingRows: null,
      items,
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  /**
   * The variant carries the SKU, the product carries the classification. Both
   * are re-asserted against `orgId`, so a variant id from another tenant
   * resolves to nothing and surfaces as 404 rather than 403 — the id must not
   * become an existence oracle.
   */
  private async loadClassification(orgId: string, productVariantId: number): Promise<{
    productId: number;
    sku: string;
    name: string;
    classification: PharmacyClassification;
  }> {
    const [row] = await this.db
      .select({
        productId: invProducts.id,
        sku: invProductVariants.sku,
        name: invProducts.name,
        mrpPaise: invProducts.mrpPaise,
        mrpRequired: invProducts.mrpRequired,
        drugSchedule: invProducts.drugSchedule,
        isHighAlert: invProducts.isHighAlert,
        lasaGroup: invProducts.lasaGroup,
        trackingMethod: invProducts.trackingMethod,
      })
      .from(invProductVariants)
      .innerJoin(
        invProducts,
        and(eq(invProducts.id, invProductVariants.productId), eq(invProducts.orgId, orgId)),
      )
      .where(
        and(
          eq(invProductVariants.id, productVariantId),
          eq(invProductVariants.orgId, orgId),
          isNull(invProductVariants.deletedAt),
        ),
      );

    if (!row) throw new NotFoundException("Product variant not found");
    return {
      productId: row.productId,
      sku: row.sku,
      name: row.name,
      classification: {
        mrpPaise: row.mrpPaise,
        mrpRequired: row.mrpRequired,
        drugSchedule: row.drugSchedule,
        isHighAlert: row.isHighAlert,
        lasaGroup: row.lasaGroup,
        trackingMethod: row.trackingMethod,
      },
    };
  }

  /** Covered by `idx_inv_products_org_lasa_group`. Live rows only — a warning naming an archived SKU sends the picker to an empty bin. */
  private async loadConfusable(
    orgId: string,
    productId: number,
    lasaGroup: string | null,
  ): Promise<ConfusableSku[]> {
    if (!lasaGroup) return [];
    return this.db
      .select({ productId: invProducts.id, sku: invProducts.sku, name: invProducts.name })
      .from(invProducts)
      .where(
        and(
          eq(invProducts.orgId, orgId),
          eq(invProducts.lasaGroup, lasaGroup),
          ne(invProducts.id, productId),
          isNull(invProducts.deletedAt),
        ),
      )
      .orderBy(asc(invProducts.name))
      .limit(InvPharmacyService.MAX_CONFUSABLE);
  }

  /**
   * The batch MRP ladder — read directly off `inv_lots` rather than through the
   * traceability module, because this is a projection of five columns and not a
   * lot lifecycle operation. Newest expiry last: at the counter the batch that
   * goes first is the one that expires first.
   */
  private async loadBatches(orgId: string, productVariantId: number) {
    return this.db
      .select({
        lotId: invLots.id,
        lotNumber: invLots.lotNumber,
        expiryDate: invLots.expiryDate,
        status: invLots.status,
        mrpPaise: invLots.mrpPaise,
      })
      .from(invLots)
      .where(and(eq(invLots.orgId, orgId), eq(invLots.productVariantId, productVariantId)))
      .orderBy(asc(invLots.expiryDate), desc(invLots.id))
      .limit(InvPharmacyService.MAX_BATCHES);
  }
}
