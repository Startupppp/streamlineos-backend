import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { offerFulfillmentComponents, invSalesOrders, invSoLines, invProductVariants } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import { dealClosedPayloadSchema } from "../../common/outbox/outbox-event-schema";
import { NumberSequenceService } from "../inventory/stock-engine/number-sequence.service";
import { addDec, mulDec } from "../inventory/stock-engine/stock-engine.service";

const CONSUMER_NAME = "offer-fulfillment:deal-closed";

type OutboxEventRow = {
  eventId: string;
  organizationId: string;
  aggregateVersion: number;
  payload: Record<string, unknown>;
};

/**
 * Handles `deal.closed` outbox events and creates a DRAFT inventory sales order for each
 * fulfilled offer mapped via `offer_fulfillment_components`.
 *
 * ARCHITECTURAL NOTE — DATA GAP:
 * The `deals` table carries only a scalar total value (no product line items / deal_products
 * junction). The `offer_fulfillment_components` bridge maps crm_products → inv_product_variants,
 * but a closed deal does not include a crm_product list in its payload.
 *
 * As a result this consumer creates a sales order only when at least one active
 * `offer_fulfillment_components` mapping exists for the org. It synthesises a single-unit order
 * line per mapped SKU (quantity = quantityPerUnit from the mapping, unitPrice derived from the
 * variant's sellingPrice) so the SO is immediately visible in Inventory for manual review and
 * adjustment before confirmation. A human operator or a future `deal_line_items` feature should
 * confirm/adjust the SO quantities.
 *
 * Idempotency: the InboxConsumer claim fence ensures exactly-once processing per
 * (eventId, consumerName) pair.
 */
@Injectable()
export class DealClosedConsumerService {
  private readonly logger = new Logger(DealClosedConsumerService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly numSeq: NumberSequenceService,
  ) {}

  async handle(event: OutboxEventRow): Promise<void> {
    const inbox = new InboxConsumer(this.db);

    const claimed = await inbox.claim(CONSUMER_NAME, {
      eventId: event.eventId,
      organizationId: event.organizationId,
      aggregateVersion: event.aggregateVersion,
    });

    if (!claimed) {
      this.logger.debug(`deal.closed ${event.eventId} already processed by ${CONSUMER_NAME} — skipping`);
      return;
    }

    try {
      const parseResult = dealClosedPayloadSchema.safeParse(event.payload);
      if (!parseResult.success) {
        this.logger.warn(`deal.closed ${event.eventId} has invalid payload: ${parseResult.error.message}`);
        await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", parseResult.error.message);
        return;
      }

      const payload = parseResult.data;
      const orgId = event.organizationId;

      const mappings = await this.db
        .select({
          invSkuId: offerFulfillmentComponents.invSkuId,
          quantityPerUnit: offerFulfillmentComponents.quantityPerUnit,
        })
        .from(offerFulfillmentComponents)
        .where(
          and(
            eq(offerFulfillmentComponents.orgId, orgId),
            eq(offerFulfillmentComponents.crmOfferOrgId, orgId),
            eq(offerFulfillmentComponents.status, "active"),
          ),
        )
        .limit(100);

      if (mappings.length === 0) {
        this.logger.debug(
          `deal.closed ${event.eventId}: no active offer-fulfillment mappings for org ${orgId} — no SO created`,
        );
        await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", null);
        return;
      }

      const variants = await this.db
        .select({ id: invProductVariants.id, sellingPrice: invProductVariants.sellingPrice })
        .from(invProductVariants)
        .where(eq(invProductVariants.orgId, orgId));

      const variantMap = new Map(variants.map((v) => [v.id, v.sellingPrice]));

      const lines = mappings
        .filter((m) => variantMap.has(m.invSkuId))
        .map((m, idx) => ({
          productVariantId: m.invSkuId,
          quantity: m.quantityPerUnit,
          unitPrice: variantMap.get(m.invSkuId) ?? "0",
          taxRate: "0",
          lineOrder: idx,
        }));

      if (lines.length === 0) {
        this.logger.warn(`deal.closed ${event.eventId}: mapped SKUs not found in org ${orgId} variants — no SO created`);
        await inbox.markProcessed(CONSUMER_NAME, event.eventId, "SKIPPED", "mapped SKUs not found");
        return;
      }

      let subtotal = "0";
      let taxAmount = "0";
      for (const l of lines) {
        const lineAmt = mulDec(parseFloat(l.quantity).toFixed(4), l.unitPrice);
        subtotal = addDec(subtotal, lineAmt);
        taxAmount = addDec(taxAmount, mulDec(lineAmt, (parseFloat(l.taxRate) / 100).toFixed(10)));
      }
      const total = addDec(subtotal, taxAmount);

      const today = new Date().toISOString().split("T")[0]!;

      type TxType = Parameters<Parameters<Db["transaction"]>[0]>[0];

      await this.db.transaction(async (tx) => {
        const soNumber = await this.numSeq.next(orgId, "SO", tx as TxType);

        const [header] = await (tx as Db)
          .insert(invSalesOrders)
          .values({
            orgId,
            soNumber,
            orderDate: today,
            subtotal,
            taxAmount,
            discount: "0",
            total,
            currency: "INR",
            notes: `Auto-created from deal "${payload.dealName}" (id=${payload.dealId}) via offer-fulfillment. Review and adjust quantities before confirming.`,
            createdBy: payload.actorUserId,
          })
          .returning({ id: invSalesOrders.id });

        if (!header) throw new Error("Failed to insert inv_sales_orders header");

        await (tx as Db).insert(invSoLines).values(
          lines.map((l) => ({
            soId: header.id,
            productVariantId: l.productVariantId,
            quantity: parseFloat(l.quantity).toFixed(4),
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            amount: mulDec(parseFloat(l.quantity).toFixed(4), l.unitPrice),
            costAtTime: "0",
            lineOrder: l.lineOrder,
          })),
        );

        const txInbox = new InboxConsumer(tx as TxType);
        await txInbox.markProcessed(CONSUMER_NAME, event.eventId, "COMPLETED", null);
      });

      this.logger.log(`deal.closed ${event.eventId}: DRAFT SO created for deal ${payload.dealId} org ${orgId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`deal.closed ${event.eventId} handler failed: ${msg}`);
      await inbox.markProcessed(CONSUMER_NAME, event.eventId, "FAILED", msg);
    }
  }
}
