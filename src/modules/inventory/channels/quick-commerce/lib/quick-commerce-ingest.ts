import { createHash } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  invChannels,
  invPlatformPoLines,
  invPlatformPurchaseOrders,
} from "../../../../../db/schema";
import { type Db } from "../../../../../db/drizzle.module";
import { runIdempotent } from "../../../stock-engine/idempotency";
import type { PlatformPoDetail } from "./quick-commerce-documents";
import { InventorySettingsService } from "../../../stock-engine/inventory-settings.service";
import { InventoryAuditService } from "../../../stock-engine/inventory-audit.service";
import { WarehouseScopeService } from "../../../stock-engine/warehouse-scope.service";
import type {
  QuickCommerceInboundAdapter,
  QuickCommerceProvider,
} from "../quick-commerce-inbound";
import type { IngestPlatformPoInput } from "../dto/quick-commerce.schemas";
import { resolveLines, type FieldError } from "./quick-commerce-line-resolution";

/**
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and every caller stay unchanged, and nothing
 * here opens a transaction the service did not.
 *
 * `reloadUnscopedPo` is a CALLBACK rather than an imported read, deliberately.
 * `detailUnscoped` is the read that skips `platformPoInScope`, and its comment
 * on the service says it is "named so nobody routes to it by accident";
 * exporting it from `lib/` would make it importable from anywhere. Handing this
 * flow a bound closure keeps the ungated read private to the service, which is
 * the only place that has already asserted the caller's warehouse.
 */
export interface QcIngestDeps {
  readonly db: Db;
  readonly settings: InventorySettingsService;
  readonly audit: InventoryAuditService;
  readonly warehouseScope: WarehouseScopeService;
  readonly adapters: ReadonlyMap<QuickCommerceProvider, QuickCommerceInboundAdapter>;
  readonly reloadUnscopedPo: (orgId: string, platformPoId: number) => Promise<PlatformPoDetail>;
}

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
export async function ingestPurchaseOrder(
  deps: QcIngestDeps,
  orgId: string,
  userId: string,
  input: IngestPlatformPoInput,
  idempotencyKey: string,
) {
  /*
   * The warehouse this document is for, and the caller has to hold it.
   * `input.warehouseId` came straight off the request body and was written
   * unchecked; nothing downstream catches it, because ingesting posts no
   * movements and the stock engine's `assertLocationsInScope` never runs on
   * this path.
   *
   * The judgement is not really open here — this service's own two siblings
   * already made it. `acceptPurchaseOrder` asserts `input.warehouseId` before
   * turning the document into a Streamline PO, and `createAsn` asserts the
   * warehouse it books an appointment against. Ingest is the door those two
   * are reached through: the warehouse it stamps on the row is the building
   * that will fulfil the platform's order, and once a scoped operator has
   * stamped somebody else's, the fill-rate and dock work hang off it.
   *
   * Only asserted when one is given: the column is nullable and the field is
   * optional, because a document can legitimately arrive before anyone has
   * decided which building serves it. 404 rather than 403, so naming a
   * warehouse you cannot see does not confirm it exists.
   *
   * FIRST, before the settings read, the adapter, the parse and the duplicate
   * probe. A caller who may not see the warehouse should cause no work on its
   * behalf and should not be able to read the refusal's shape to learn which
   * packs this organisation has switched on or whether a provider PO number is
   * already held. The spec's db stub has only `transaction`, so any query
   * before this check TypeErrors — the ordering is asserted, not described.
   */
  if (input.warehouseId != null) {
    await deps.warehouseScope.assertWarehouseVisible(orgId, userId, input.warehouseId);
  }

  const settings = await deps.settings.get(orgId);
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

  const adapter = deps.adapters.get(input.provider);
  if (!adapter) throw new BadRequestException(`No adapter for provider ${input.provider}`);

  const parsed = adapter.parsePurchaseOrder(input.payload);
  const payloadDigest = createHash("sha256")
    .update(JSON.stringify(input.payload))
    .digest("hex");

  // Read before the transaction: the overwhelmingly common retry is a document
  // we have already handled, and it should not take a write lock to say so.
  const existing = await findByProviderNumber(deps, orgId, parsed.provider, parsed.providerPoNumber);
  if (existing) return deps.reloadUnscopedPo(orgId, existing.id);

  const resolved = await resolveLines(deps, orgId, parsed);
  const fieldErrors = resolved
    .filter((line) => line.validationError !== null)
    .map<FieldError>((line) => ({
      lineOrder: line.lineOrder,
      field: line.ean ? "ean" : "providerSku",
      message: line.validationError!,
    }));

  const channel = await channelForProvider(deps, orgId, parsed.provider);

  const created = await deps.db.transaction((tx) =>
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

        await deps.audit.insert(tx, {
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
    const row = await findByProviderNumber(deps, orgId, parsed.provider, parsed.providerPoNumber);
    if (!row) throw new ConflictException("Purchase order ingest raced and could not be re-read");
    return deps.reloadUnscopedPo(orgId, row.id);
  }

  if (fieldErrors.length > 0) {
    throw new ConflictException({
      code: "PLATFORM_PO_VALIDATION_FAILED",
      message: `${fieldErrors.length} line(s) could not be matched to this catalogue`,
      platformPoId: created.platformPoId,
      fieldErrors,
    });
  }

  return deps.reloadUnscopedPo(orgId, created.platformPoId);
}

async function channelForProvider(deps: QcIngestDeps, orgId: string, provider: QuickCommerceProvider) {
  const [channel] = await deps.db
    .select({ id: invChannels.id, name: invChannels.name })
    .from(invChannels)
    .where(and(eq(invChannels.orgId, orgId), eq(invChannels.qcProvider, provider)));
  return channel ?? null;
}

async function findByProviderNumber(deps: QcIngestDeps, orgId: string, provider: QuickCommerceProvider, number: string) {
  const [row] = await deps.db
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
