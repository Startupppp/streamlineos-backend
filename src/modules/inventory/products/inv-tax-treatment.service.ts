import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { invProducts, invProductVariants } from "../../../db/schema";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import {
  resolveTaxSnapshot,
  type LineTaxSnapshot,
  type ProductTaxClassification,
  type TaxDocumentKind,
} from "./lib/line-tax";

export type { LineTaxSnapshot, TaxDocumentKind } from "./lib/line-tax";

export interface ResolveLineTaxInput {
  productVariantId: number;
  /** The line's tax-exclusive taxable value: entered quantity × unit price. */
  taxableAmount: string;
  documentKind: TaxDocumentKind;
  /** Absent means "take the SKU's default". */
  taxRate?: string;
}

/**
 * E2 — the tax inputs a document line has to record, and the one figure that
 * follows from them.
 *
 * Inventory does not file a return. It answers one question — "for this SKU, on
 * this kind of document, what were the tax inputs at this moment" — and the
 * answer is written onto the line so it stays true after the catalogue moves.
 * Accounting and billing decide what to do with it.
 *
 * The reason this is a service and not four columns copied at three call sites
 * is the composition rule. A composition dealer pays tax out of turnover and may
 * not collect it from a customer, so an outward line showing a split is an
 * invoice that could not lawfully have been raised. That rule has to hold on
 * purchase orders, goods receipts and sales orders alike; three copies of it stay
 * equal only until one of them is edited.
 */
@Injectable()
export class InvTaxTreatmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: InventorySettingsService,
  ) {}

  async resolveLineTax(orgId: string, input: ResolveLineTaxInput): Promise<LineTaxSnapshot> {
    const settings = await this.settings.get(orgId);

    // With the pack off there is nothing to classify by, so the SKU is not read
    // at all — a gate that still costs a join is a gate that gets removed.
    const classification = settings.packs.gst
      ? await this.loadClassification(orgId, input.productVariantId)
      : null;

    return resolveTaxSnapshot({
      classification,
      gstMode: settings.gstMode,
      documentKind: input.documentKind,
      taxableAmount: input.taxableAmount,
      requestedRate: input.taxRate,
    });
  }

  /**
   * The variant carries the SKU, the product carries the classification. Both
   * are re-asserted against `orgId`: a variant id from another tenant resolves
   * to nothing here, and that surfaces as 404 rather than 403, so the id is not
   * an existence oracle.
   */
  private async loadClassification(
    orgId: string,
    productVariantId: number,
  ): Promise<ProductTaxClassification> {
    const [row] = await this.db
      .select({
        hsnCode: invProducts.hsnCode,
        taxTreatment: invProducts.taxTreatment,
        gstRate: invProducts.gstRate,
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
    return row;
  }
}
