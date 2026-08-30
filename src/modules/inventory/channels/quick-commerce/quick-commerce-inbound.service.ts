import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  invAsnLines,
  invAsns,
  invBarcodes,
  invChannels,
  invPlatformPoLines,
  invPlatformPurchaseOrders,
  invProductVariants,
  invProducts,
  invPurchaseOrders,
  invPoLines,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { InventorySettingsService } from "../../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import { NumberSequenceService } from "../../stock-engine/number-sequence.service";
import { ChannelPoolService } from "../../stock-engine/channel-pool.service";
import { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import { runIdempotent } from "../../stock-engine/idempotency";
import { addDec, mulDec } from "../../stock-engine/decimal";
import {
  BlinkitInboundAdapter,
  InstamartInboundAdapter,
  ZeptoEmailInboundAdapter,
  type ParsedPlatformPo,
  type QuickCommerceInboundAdapter,
  type QuickCommerceProvider,
} from "./quick-commerce-inbound";
import type {
  AcceptPlatformPoInput,
  CreateAsnInput,
  IngestPlatformPoInput,
  ListPlatformPosQuery,
} from "./dto/quick-commerce.schemas";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** One line's verdict: the variant it resolved to, or why it did not. */
interface ResolvedLine {
  lineOrder: number;
  providerSku: string | null;
  ean: string | null;
  mrpPaise: number | null;
  packSize: number | null;
  quantityOrdered: string;
  unitCost: string | null;
  productVariantId: number | null;
  validationError: string | null;
}

export interface FieldError {
  lineOrder: number;
  field: string;
  message: string;
}

@Injectable()
export class QuickCommerceInboundService {
  private readonly adapters: ReadonlyMap<QuickCommerceProvider, QuickCommerceInboundAdapter> = new Map<
    QuickCommerceProvider,
    QuickCommerceInboundAdapter
  >([
    ["BLINKIT", new BlinkitInboundAdapter()],
    ["INSTAMART", new InstamartInboundAdapter()],
    ["ZEPTO", new ZeptoEmailInboundAdapter()],
  ]);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: InventorySettingsService,
    private readonly audit: InventoryAuditService,
    private readonly numSeq: NumberSequenceService,
    private readonly channelPools: ChannelPoolService,
    private readonly warehouseScope: WarehouseScopeService,
  ) {}

  /**
   * NEO-2 — ingest one platform purchase order.
   *
   * Three things happen, in this order and for a reason:
   *
   * 1. **The pack gate.** Off means the document is refused before it is parsed.
   * 2. **The fence.** `(org, provider, provider_po_number)` is unique, so a
   *    retried delivery, a re-uploaded file and a re-parsed email land on the
   *    same row. A duplicate is a *no-op returning the original*, not a 409:
   *    the caller retrying has done nothing wrong and needs the id back.
   * 3. **Validation.** Every line is resolved against this organisation's
   *    catalogue and the failures are recorded on the lines. The document is
   *    kept either way — a rejected PO with a reason per line is how somebody
   *    finds out the platform's EAN for a SKU is not one we hold, and deleting
   *    it would leave them an error toast and no evidence.
   *
   * A document with any unresolvable line is `REJECTED` and the response is a
   * 409 carrying the field errors. That is the "invalid EAN 409 with field
   * errors" the work order asks for, and the row is still there to look at.
   */
  async ingestPurchaseOrder(
    orgId: string,
    userId: string,
    input: IngestPlatformPoInput,
    idempotencyKey: string,
  ) {
    const settings = await this.settings.get(orgId);
    if (!settings.packs.quickCommerce) {
      throw new BadRequestException(
        "The quick-commerce pack is not enabled for this organisation",
      );
    }
    if (input.provider === "ZEPTO" && !settings.qcZeptoEmailPoEnabled) {
      throw new BadRequestException(
        "Zepto email purchase-order parsing is switched off. Enable it in inventory settings before ingesting one.",
      );
    }

    const adapter = this.adapters.get(input.provider);
    if (!adapter) throw new BadRequestException(`No adapter for provider ${input.provider}`);

    const parsed = adapter.parsePurchaseOrder(input.payload);
    const payloadDigest = createHash("sha256")
      .update(JSON.stringify(input.payload))
      .digest("hex");

    // Read before the transaction: the overwhelmingly common retry is a document
    // we have already handled, and it should not take a write lock to say so.
    const existing = await this.findByProviderNumber(orgId, parsed.provider, parsed.providerPoNumber);
    if (existing) return this.detail(orgId, existing.id);

    const resolved = await this.resolveLines(orgId, parsed);
    const fieldErrors = resolved
      .filter((line) => line.validationError !== null)
      .map<FieldError>((line) => ({
        lineOrder: line.lineOrder,
        field: line.ean ? "ean" : "providerSku",
        message: line.validationError!,
      }));

    const channel = await this.channelForProvider(orgId, parsed.provider);

    const created = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.quick-commerce.ingest", provider: parsed.provider, poNumber: parsed.providerPoNumber },
        async () => {
          const [header] = await tx
            .insert(invPlatformPurchaseOrders)
            .values({
              orgId,
              provider: parsed.provider,
              providerPoNumber: parsed.providerPoNumber,
              channelId: channel?.id ?? null,
              warehouseId: input.warehouseId ?? null,
              status: fieldErrors.length > 0 ? "REJECTED" : "RECEIVED",
              destinationRef: parsed.destinationRef,
              orderedAt: parsed.orderedAt,
              expectedDeliveryDate: parsed.expectedDeliveryDate,
              currency: parsed.currency,
              rejectionReason:
                fieldErrors.length > 0
                  ? `${fieldErrors.length} line(s) could not be matched to this catalogue`
                  : null,
              payloadDigest,
              createdBy: userId,
            })
            // The fence, honoured at the database rather than only by the read
            // above: two concurrent deliveries of the same PO both miss that read.
            .onConflictDoNothing({
              target: [
                invPlatformPurchaseOrders.orgId,
                invPlatformPurchaseOrders.provider,
                invPlatformPurchaseOrders.providerPoNumber,
              ],
            })
            .returning();

          if (!header) return { raced: true as const };

          await tx.insert(invPlatformPoLines).values(
            resolved.map((line) => ({
              orgId,
              platformPoId: header.id,
              lineOrder: line.lineOrder,
              providerSku: line.providerSku,
              ean: line.ean,
              mrpPaise: line.mrpPaise,
              packSize: line.packSize,
              quantityOrdered: line.quantityOrdered,
              unitCost: line.unitCost,
              productVariantId: line.productVariantId,
              validationError: line.validationError,
            })),
          );

          await this.audit.insert(tx, {
            orgId,
            actorUserId: userId,
            action: "platform_po.ingest",
            resourceType: "inv_platform_purchase_order",
            resourceId: String(header.id),
            after: { provider: parsed.provider, providerPoNumber: parsed.providerPoNumber, status: header.status },
            metadata: { lineCount: resolved.length, rejectedLines: fieldErrors.length },
          });

          return { raced: false as const, platformPoId: header.id };
        },
        (stored) => stored as { raced: boolean; platformPoId?: number },
      ),
    );

    if (created.raced || created.platformPoId === undefined) {
      const row = await this.findByProviderNumber(orgId, parsed.provider, parsed.providerPoNumber);
      if (!row) throw new ConflictException("Purchase order ingest raced and could not be re-read");
      return this.detail(orgId, row.id);
    }

    if (fieldErrors.length > 0) {
      throw new ConflictException({
        code: "PLATFORM_PO_VALIDATION_FAILED",
        message: `${fieldErrors.length} line(s) could not be matched to this catalogue`,
        platformPoId: created.platformPoId,
        fieldErrors,
      });
    }

    return this.detail(orgId, created.platformPoId);
  }

  /**
   * Resolve every line against this organisation's catalogue.
   *
   * EAN first, then the platform's SKU code against our own SKU. A barcode is
   * the identifier both sides agreed on; a SKU string matching is a fallback
   * that works only when the platform was onboarded with our codes.
   *
   * The checks after resolution are the ones a receiving clerk would otherwise
   * discover on the dock: an MRP the SKU requires and the platform omitted, and
   * a case size that disagrees with ours. Both are refusals rather than
   * warnings, because accepting them creates a purchase order whose quantities
   * mean something different to each side.
   */
  private async resolveLines(orgId: string, parsed: ParsedPlatformPo): Promise<ResolvedLine[]> {
    const eans = parsed.lines.map((l) => l.ean).filter((v): v is string => v !== null);
    const skus = parsed.lines.map((l) => l.providerSku).filter((v): v is string => v !== null);

    const byEan = new Map<string, number>();
    if (eans.length > 0) {
      const rows = await this.db
        .select({ code: invBarcodes.code, variantId: invBarcodes.productVariantId })
        .from(invBarcodes)
        .where(and(eq(invBarcodes.orgId, orgId), inArray(invBarcodes.code, eans)));
      for (const row of rows) {
        if (row.variantId !== null) byEan.set(row.code, row.variantId);
      }
    }

    const bySku = new Map<string, number>();
    // `mrpRequired` lives on the product, so the variant lookup carries its
    // product's flag rather than making the caller ask a second time.
    const variantMrpRequired = new Map<number, boolean>();
    const candidateIds = [...byEan.values()];
    const rows =
      skus.length > 0 || candidateIds.length > 0
        ? await this.db
            .select({
              id: invProductVariants.id,
              sku: invProductVariants.sku,
              mrpRequired: invProducts.mrpRequired,
            })
            .from(invProductVariants)
            .innerJoin(
              invProducts,
              and(eq(invProducts.orgId, invProductVariants.orgId), eq(invProducts.id, invProductVariants.productId)),
            )
            .where(
              and(
                eq(invProductVariants.orgId, orgId),
                sql`${invProductVariants.deletedAt} IS NULL`,
                skus.length > 0 && candidateIds.length > 0
                  ? sql`(${inArray(invProductVariants.sku, skus)} OR ${inArray(invProductVariants.id, candidateIds)})`
                  : skus.length > 0
                    ? inArray(invProductVariants.sku, skus)
                    : inArray(invProductVariants.id, candidateIds),
              ),
            )
        : [];
    for (const row of rows) {
      bySku.set(row.sku, row.id);
      variantMrpRequired.set(row.id, row.mrpRequired);
    }

    return parsed.lines.map((line) => {
      const variantId =
        (line.ean ? byEan.get(line.ean) : undefined) ??
        (line.providerSku ? bySku.get(line.providerSku) : undefined) ??
        null;

      let validationError: string | null = null;
      if (variantId === null) {
        validationError = line.ean
          ? `No product in this catalogue carries the barcode ${line.ean}`
          : line.providerSku
            ? `No product in this catalogue has the SKU ${line.providerSku}`
            : "The line names neither a barcode nor a SKU";
      } else if (variantMrpRequired.get(variantId) === true && line.mrpPaise === null) {
        validationError = "This SKU requires a printed MRP and the purchase order states none";
      } else if (line.packSize !== null && line.packSize <= 0) {
        validationError = `Pack size ${line.packSize} is not a positive number of units`;
      }

      return { ...line, productVariantId: variantId, validationError };
    });
  }

  private async channelForProvider(orgId: string, provider: QuickCommerceProvider) {
    const [channel] = await this.db
      .select({ id: invChannels.id, name: invChannels.name })
      .from(invChannels)
      .where(and(eq(invChannels.orgId, orgId), eq(invChannels.qcProvider, provider)));
    return channel ?? null;
  }

  private async findByProviderNumber(orgId: string, provider: QuickCommerceProvider, number: string) {
    const [row] = await this.db
      .select({ id: invPlatformPurchaseOrders.id })
      .from(invPlatformPurchaseOrders)
      .where(
        and(
          eq(invPlatformPurchaseOrders.orgId, orgId),
          eq(invPlatformPurchaseOrders.provider, provider),
          eq(invPlatformPurchaseOrders.providerPoNumber, number),
        ),
      );
    return row ?? null;
  }

  async list(orgId: string, query: ListPlatformPosQuery) {
    const conditions = [eq(invPlatformPurchaseOrders.orgId, orgId)];
    if (query.provider) conditions.push(eq(invPlatformPurchaseOrders.provider, query.provider));
    if (query.status) conditions.push(eq(invPlatformPurchaseOrders.status, query.status));

    return this.db
      .select({
        id: invPlatformPurchaseOrders.id,
        provider: invPlatformPurchaseOrders.provider,
        providerPoNumber: invPlatformPurchaseOrders.providerPoNumber,
        status: invPlatformPurchaseOrders.status,
        destinationRef: invPlatformPurchaseOrders.destinationRef,
        expectedDeliveryDate: invPlatformPurchaseOrders.expectedDeliveryDate,
        poId: invPlatformPurchaseOrders.poId,
        rejectionReason: invPlatformPurchaseOrders.rejectionReason,
        createdAt: invPlatformPurchaseOrders.createdAt,
      })
      .from(invPlatformPurchaseOrders)
      .where(and(...conditions))
      .orderBy(desc(invPlatformPurchaseOrders.createdAt), desc(invPlatformPurchaseOrders.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
  }

  async detail(orgId: string, platformPoId: number) {
    const [header] = await this.db
      .select()
      .from(invPlatformPurchaseOrders)
      .where(and(eq(invPlatformPurchaseOrders.orgId, orgId), eq(invPlatformPurchaseOrders.id, platformPoId)));
    if (!header) throw new NotFoundException("Not found");

    const lines = await this.db
      .select()
      .from(invPlatformPoLines)
      .where(and(eq(invPlatformPoLines.orgId, orgId), eq(invPlatformPoLines.platformPoId, platformPoId)))
      .orderBy(asc(invPlatformPoLines.lineOrder));

    return { ...header, lines };
  }

  /**
   * Turn an ingested platform PO into a Streamline purchase order, and claim the
   * stock for the platform's channel.
   *
   * The claim is the point of connecting NEO-2 to NEO-1: once Blinkit's order is
   * accepted, those units stop being offered on the storefront. It is best-effort
   * per line and recorded rather than fatal — a platform ordering more than we
   * hold is an ordinary commercial event, and refusing the whole acceptance over
   * it would leave the PO in limbo with no purchase order behind it.
   */
  async acceptPurchaseOrder(
    orgId: string,
    userId: string,
    platformPoId: number,
    input: AcceptPlatformPoInput,
    idempotencyKey: string,
  ) {
    const detail = await this.detail(orgId, platformPoId);
    if (detail.status === "REJECTED") {
      throw new BadRequestException(
        "This purchase order has lines that do not match the catalogue and cannot be accepted",
      );
    }
    if (detail.status === "CANCELLED") {
      throw new BadRequestException("This purchase order has been cancelled");
    }
    if (detail.poId !== null) return this.detail(orgId, platformPoId);

    await this.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);

    const lines = detail.lines.filter((l) => l.productVariantId !== null);
    if (lines.length === 0) throw new BadRequestException("This purchase order has no usable lines");

    await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.quick-commerce.accept", platformPoId },
        async () => {
          const poNumber = await this.numSeq.next(orgId, "PO", tx);
          const subtotal = lines.reduce(
            (sum, line) => addDec(sum, mulDec(line.quantityOrdered, line.unitCost ?? "0")),
            "0",
          );

          const [po] = await tx
            .insert(invPurchaseOrders)
            .values({
              orgId,
              vendorId: input.vendorId,
              poNumber,
              status: "DRAFT",
              orderDate: input.orderDate,
              expectedDeliveryDate: detail.expectedDeliveryDate,
              warehouseId: input.warehouseId,
              subtotal,
              taxAmount: "0",
              discount: "0",
              total: subtotal,
              currency: detail.currency,
              notes: `${detail.provider} PO ${detail.providerPoNumber}`,
              createdBy: userId,
            })
            .returning();

          await tx.insert(invPoLines).values(
            lines.map((line, index) => ({
              orgId,
              poId: po!.id,
              productVariantId: line.productVariantId!,
              quantity: line.quantityOrdered,
              unitCost: line.unitCost ?? "0",
              taxRate: "0",
              amount: mulDec(line.quantityOrdered, line.unitCost ?? "0"),
              lineOrder: index,
            })),
          );

          await tx
            .update(invPlatformPurchaseOrders)
            .set({ status: "ACCEPTED", poId: po!.id, warehouseId: input.warehouseId, updatedAt: new Date() })
            .where(
              and(
                eq(invPlatformPurchaseOrders.orgId, orgId),
                eq(invPlatformPurchaseOrders.id, platformPoId),
              ),
            );

          await this.audit.insert(tx, {
            orgId,
            actorUserId: userId,
            action: "platform_po.accept",
            resourceType: "inv_platform_purchase_order",
            resourceId: String(platformPoId),
            after: { poId: po!.id, poNumber },
          });

          return { poId: po!.id };
        },
        (stored) => stored as { poId: number },
      ),
    );

    // Outside the acceptance transaction on purpose: a claim that cannot be met
    // must not roll the purchase order back. Each allocation is idempotent on its
    // own key, so a retry of `accept` does not double-claim.
    if (detail.channelId !== null && input.reserveIntoChannelPool) {
      for (const line of lines) {
        try {
          await this.channelPools.allocate(orgId, userId, {
            channelId: detail.channelId,
            productVariantId: line.productVariantId!,
            warehouseId: input.warehouseId,
            deltaQty: line.quantityOrdered,
            idempotencyKey: `${idempotencyKey}:pool:${line.id}`,
          });
        } catch {
          // Recorded by the pool service's own audit trail when it succeeds; a
          // refusal here means the platform ordered more than we hold, which is
          // an ordinary commercial event and not a reason to unwind the PO.
        }
      }
    }

    return this.detail(orgId, platformPoId);
  }

  /* ---------------------------------------------------------------- *
   * ASN
   * ---------------------------------------------------------------- */

  /**
   * Announce a shipment against a purchase order.
   *
   * An ASN moves no stock. It is the document the dock plans against, and the
   * thing `asnRequiredForGrn` makes receiving depend on — so it is created and
   * confirmed here, and consumed by the GRN path.
   */
  async createAsn(orgId: string, userId: string, input: CreateAsnInput, idempotencyKey: string) {
    const [po] = await this.db
      .select({ id: invPurchaseOrders.id, warehouseId: invPurchaseOrders.warehouseId })
      .from(invPurchaseOrders)
      .where(and(eq(invPurchaseOrders.orgId, orgId), eq(invPurchaseOrders.id, input.poId)));
    if (!po) throw new NotFoundException("Not found");

    const warehouseId = input.warehouseId ?? po.warehouseId ?? null;
    await this.warehouseScope.assertWarehouseVisible(orgId, userId, warehouseId ?? undefined);

    const asnId = await this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.asn.create", poId: input.poId, lines: input.lines },
        async () => {
          const asnNumber = await this.numSeq.next(orgId, "ASN", tx);
          const [asn] = await tx
            .insert(invAsns)
            .values({
              orgId,
              asnNumber,
              platformPoId: input.platformPoId ?? null,
              poId: input.poId,
              warehouseId,
              locationId: input.locationId ?? null,
              status: "CONFIRMED",
              carrierName: input.carrierName ?? null,
              trackingRef: input.trackingRef ?? null,
              appointmentStart: input.appointmentStart ? new Date(input.appointmentStart) : null,
              appointmentEnd: input.appointmentEnd ? new Date(input.appointmentEnd) : null,
              expectedArrival: input.expectedArrival ?? null,
              notes: input.notes ?? null,
              createdBy: userId,
            })
            .returning();

          await tx.insert(invAsnLines).values(
            input.lines.map((line, index) => ({
              orgId,
              asnId: asn!.id,
              poLineId: line.poLineId ?? null,
              productVariantId: line.productVariantId,
              quantityExpected: line.quantityExpected,
              lotNumber: line.lotNumber ?? null,
              expiryDate: line.expiryDate ?? null,
              mrpPaise: line.mrpPaise ?? null,
              lineOrder: index,
            })),
          );

          await this.audit.insert(tx, {
            orgId,
            actorUserId: userId,
            action: "asn.create",
            resourceType: "inv_asn",
            resourceId: String(asn!.id),
            after: { asnNumber, poId: input.poId, lineCount: input.lines.length },
          });

          return { asnId: asn!.id };
        },
        (stored) => stored as { asnId: number },
      ),
    );

    return this.asnDetail(orgId, asnId.asnId);
  }

  async asnDetail(orgId: string, asnId: number) {
    const [header] = await this.db
      .select()
      .from(invAsns)
      .where(and(eq(invAsns.orgId, orgId), eq(invAsns.id, asnId)));
    if (!header) throw new NotFoundException("Not found");

    const lines = await this.db
      .select()
      .from(invAsnLines)
      .where(and(eq(invAsnLines.orgId, orgId), eq(invAsnLines.asnId, asnId)))
      .orderBy(asc(invAsnLines.lineOrder));

    return { ...header, lines };
  }

  async listAsns(orgId: string, userId: string, query: { poId?: number; status?: string; limit: number; page: number }) {
    const scope = await this.warehouseScope.resolve(orgId, userId);
    const conditions = [eq(invAsns.orgId, orgId)];
    if (query.poId) conditions.push(eq(invAsns.poId, query.poId));
    if (query.status) conditions.push(sql`${invAsns.status} = ${query.status}`);
    if (scope !== null) {
      conditions.push(
        scope.length === 0
          ? sql`FALSE`
          : sql`(${invAsns.warehouseId} IS NULL OR ${inArray(invAsns.warehouseId, scope)})`,
      );
    }

    return this.db
      .select({
        id: invAsns.id,
        asnNumber: invAsns.asnNumber,
        poId: invAsns.poId,
        platformPoId: invAsns.platformPoId,
        warehouseId: invAsns.warehouseId,
        status: invAsns.status,
        carrierName: invAsns.carrierName,
        appointmentStart: invAsns.appointmentStart,
        appointmentEnd: invAsns.appointmentEnd,
        expectedArrival: invAsns.expectedArrival,
        createdAt: invAsns.createdAt,
      })
      .from(invAsns)
      .where(and(...conditions))
      .orderBy(desc(invAsns.createdAt), desc(invAsns.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit);
  }

  /**
   * The gate `inv_settings.asn_required_for_grn` turns on.
   *
   * Called by the GRN draft path rather than living there, so the rule has one
   * home: a receipt may not be raised against a purchase order nobody announced.
   * Off by default, because most warehouses receive against a purchase order and
   * nothing else, and demanding an ASN they do not raise would stop receiving.
   */
  async assertReceivable(
    tx: Tx,
    orgId: string,
    params: { poId: number; asnId: number | null },
  ): Promise<void> {
    const settings = await this.settings.get(orgId);
    if (!settings.asnRequiredForGrn) return;

    if (params.asnId === null) {
      const [any] = await tx
        .select({ id: invAsns.id })
        .from(invAsns)
        .where(
          and(
            eq(invAsns.orgId, orgId),
            eq(invAsns.poId, params.poId),
            sql`${invAsns.status} IN ('CONFIRMED', 'IN_TRANSIT', 'ARRIVED')`,
          ),
        );
      if (!any) {
        throw new BadRequestException(
          "This organisation requires an advance shipping notice before a delivery can be received",
        );
      }
      return;
    }

    const [asn] = await tx
      .select({ id: invAsns.id, poId: invAsns.poId, status: invAsns.status })
      .from(invAsns)
      .where(and(eq(invAsns.orgId, orgId), eq(invAsns.id, params.asnId)));
    if (!asn) throw new NotFoundException("Not found");
    if (asn.poId !== params.poId) {
      throw new BadRequestException("That advance shipping notice belongs to a different purchase order");
    }
    if (asn.status === "CANCELLED" || asn.status === "CLOSED") {
      throw new BadRequestException(`That advance shipping notice is ${asn.status.toLowerCase()}`);
    }
  }
}
