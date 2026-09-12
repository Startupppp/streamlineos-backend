import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  invPurchaseOrders,
  invPoLines,
  invGrns,
  invGrnLines,
  invLots,
  invSerialNumbers,
  invQualityInspections,
  invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { INV_ERRORS } from "../stock-engine/stock-engine.types";
import { addDec, mulDec, isPositive } from "../stock-engine/decimal";
import { PostingCommandService } from "../../accounting/adapters/posting-command.service";
import { AdapterRejection } from "../../accounting/adapters/posting-command.types";
import type { DbOrTx } from "../../accounting/kernel/sequence.service";
import type { CreateGrnInput } from "./dto/inv-purchase-orders.schemas";
import { PoService } from "./po.service";

@Injectable()
export class GrnReceiveService {
  private readonly logger = new Logger(GrnReceiveService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly settingsService: InventorySettingsService,
    private readonly numSeq: NumberSequenceService,
    private readonly posting: PostingCommandService,
    private readonly poService: PoService,
  ) {}

  async receiveGoods(
    orgId: string,
    poId: number,
    userId: string,
    idempotencyKey: string,
    data: CreateGrnInput,
  ) {
    const po = await this.db.query.invPurchaseOrders.findFirst({
      where: and(
        eq(invPurchaseOrders.id, poId),
        eq(invPurchaseOrders.orgId, orgId),
      ),
      with: {
        lines: {
          with: {
            productVariant: {
              with: {
                product: { columns: { id: true, trackingMethod: true } },
              },
            },
          },
        },
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "SENT" && po.status !== "PARTIAL") {
      throw new BadRequestException(
        "Purchase order must be SENT or PARTIAL to receive goods",
      );
    }

    const settings = await this.settingsService.get(orgId);
    let locationId: number;
    if (data.locationId != null) {
      const loc = await this.db.query.invLocations.findFirst({
        where: and(
          eq(invLocations.id, data.locationId),
          eq(invLocations.orgId, orgId),
          eq(invLocations.isActive, true),
        ),
        columns: { id: true },
      });
      if (!loc) throw new NotFoundException("Location not found or inactive");
      locationId = loc.id;
    } else
      locationId = await this.poService.resolveLocationId(
        orgId,
        po.warehouseId,
      );

    const grnNumber = await this.numSeq.next(orgId, "GRN");

    const overReceiptTolerancePct = Number(settings.overReceiptTolerancePct);

    const lotMap = new Map<string, number>();
    const serialMap = new Map<string, number>();

    const grnId = await this.db.transaction(async (tx) => {
      for (const line of data.lines) {
        const poLine = po.lines.find((l) => l.id === line.poLineId);
        if (!poLine)
          throw new BadRequestException(`PO line ${line.poLineId} not found`);

        const trackingMethod = poLine.productVariant.product.trackingMethod;

        const [lockedLine] = await tx.execute<{
          quantity: string;
          quantity_received: string;
        }>(sql`
          SELECT quantity, quantity_received
          FROM inv_po_lines
          WHERE id = ${line.poLineId}
            AND po_id = ${poId}
          FOR UPDATE
        `);
        if (!lockedLine)
          throw new BadRequestException(`PO line ${line.poLineId} not found`);

        const quantity = Number(lockedLine.quantity);
        const quantityReceived = Number(lockedLine.quantity_received);
        const remaining = quantity - quantityReceived;
        const maxAllowed =
          remaining * (1 + overReceiptTolerancePct / 100);

        const incomingQuantityReceived = Number(line.quantityReceived);
        if (incomingQuantityReceived > maxAllowed + 0.0001) {
          throw new BadRequestException(
            `Line ${line.poLineId}: received qty ${incomingQuantityReceived} exceeds allowed max ${maxAllowed.toFixed(4)} (over-receipt tolerance ${settings.overReceiptTolerancePct}%)`,
          );
        }

        if (trackingMethod === "SERIAL") {
          const serials = line.serialNumbers ?? [];
          if (serials.length !== incomingQuantityReceived) {
            throw new BadRequestException(
              `Line ${line.poLineId}: SERIAL-tracked product requires ${incomingQuantityReceived} serial numbers, got ${serials.length}`,
            );
          }

          const existing = await tx.query.invSerialNumbers.findMany({
            where: and(
              eq(invSerialNumbers.orgId, orgId),
              eq(invSerialNumbers.productVariantId, poLine.productVariantId),
              inArray(invSerialNumbers.serialNumber, serials),
            ),
            columns: { serialNumber: true, status: true },
          });
          const duplicates = existing.filter((s) => s.status !== "RETURNED");
          if (duplicates.length > 0) {
            throw new BadRequestException({
              code: INV_ERRORS.SERIAL_ALREADY_USED,
              serials: duplicates.map((s) => s.serialNumber),
            });
          }
        }
      }

      const [grn] = await tx
        .insert(invGrns)
        .values({
          orgId,
          poId,
          grnNumber,
          locationId,
          notes: data.notes,
          createdBy: userId,
          receivedDate: data.receivedDate,
          /*
           * POSTED at insert, because this path posts. It writes the stock
           * movements through `engine.executeInTx` and the receipt journal
           * below, in this same transaction -- the goods have landed by the
           * time it commits.
           *
           * Leaving these to the column default wrote DRAFT onto a receipt
           * whose stock had already moved, and `GrnPostingService.postInTx`
           * refuses only POSTED and CANCELLED. So the workbench went on
           * offering "Post to stock" on a delivery that was already in the
           * building, and taking it moved the same goods a SECOND time and
           * posted a second journal entry. Measured on GRN-00003/4/5, each
           * carrying a GRN movement while sitting at DRAFT with a null
           * posted_at.
           *
           * Same three columns the two-step path sets when it finishes
           * (grn-post.service.ts), so both routes leave a receipt in one
           * shape rather than two.
           */
          status: "POSTED",
          postedBy: userId,
          postedAt: new Date(),
        })
        .returning();

      const acceptedMovements: Array<{
        transactionType: string;
        productVariantId: number;
        locationId: number;
        lotId: number | undefined;
        serialId: number | undefined;
        quantityDelta: string;
        unitCost: string | undefined;
      }> = [];

      for (const line of data.lines) {
        const poLine = po.lines.find((l) => l.id === line.poLineId)!;
        const trackingMethod = poLine.productVariant.product.trackingMethod;

        let resolvedLotId: number | undefined;
        const resolvedSerialIds: number[] = [];

        if (trackingMethod === "LOT" && line.lotNumber) {
          const existing = await tx.query.invLots.findFirst({
            where: and(
              eq(invLots.orgId, orgId),
              eq(invLots.productVariantId, poLine.productVariantId),
              eq(invLots.lotNumber, line.lotNumber),
            ),
            columns: { id: true },
          });

          if (existing) {
            resolvedLotId = existing.id;
          } else {
            const [newLot] = await tx
              .insert(invLots)
              .values({
                orgId,
                status: "ACTIVE",
                lotNumber: line.lotNumber,
                expiryDate: line.expiryDate,
                manufactureDate: line.manufactureDate,
                productVariantId: poLine.productVariantId,
              })
              .returning({ id: invLots.id });
            resolvedLotId = newLot.id;
          }
          lotMap.set(
            `${poLine.productVariantId}:${line.lotNumber}`,
            resolvedLotId,
          );
        }

        if (trackingMethod === "SERIAL" && line.serialNumbers?.length) {
          const serials = line.serialNumbers;
          const existing = await tx.query.invSerialNumbers.findMany({
            where: and(
              eq(invSerialNumbers.orgId, orgId),
              eq(invSerialNumbers.productVariantId, poLine.productVariantId),
              inArray(invSerialNumbers.serialNumber, serials),
            ),
            columns: { id: true, serialNumber: true },
          });
          const existingMap = new Map(
            existing.map((s) => [s.serialNumber, s.id]),
          );
          const toInsert = serials.filter((sn) => !existingMap.has(sn));
          const toUpdateIds = existing.map((s) => s.id);

          if (toUpdateIds.length > 0) {
            await tx
              .update(invSerialNumbers)
              .set({ status: "IN_STOCK", currentLocationId: locationId })
              .where(inArray(invSerialNumbers.id, toUpdateIds));
            for (const s of existing) resolvedSerialIds.push(s.id);
          }

          if (toInsert.length > 0) {
            const inserted = await tx
              .insert(invSerialNumbers)
              .values(
                toInsert.map((sn) => ({
                  orgId,
                  serialNumber: sn,
                  lotId: resolvedLotId,
                  status: "IN_STOCK" as const,
                  currentLocationId: locationId,
                  productVariantId: poLine.productVariantId,
                })),
              )
              .returning({
                id: invSerialNumbers.id,
                serialNumber: invSerialNumbers.serialNumber,
              });
            for (const row of inserted) {
              resolvedSerialIds.push(row.id);
              serialMap.set(row.serialNumber, row.id);
            }
          }
        }

        await tx.insert(invGrnLines).values({
          orgId,
          grnId: grn.id,
          poLineId: line.poLineId,
          quantityReceived: line.quantityReceived.toString(),
          qualityStatus: line.qualityStatus,
          rejectionReason: line.rejectionReason,
        });

        await tx
          .update(invPoLines)
          .set({
            quantityReceived: sql`${invPoLines.quantityReceived} + ${line.quantityReceived}`,
          })
          .where(
            and(
              eq(invPoLines.id, line.poLineId),
              eq(invPoLines.poId, poId),
            ),
          );

        if (line.qualityStatus === "ACCEPTED") {
          if (trackingMethod === "SERIAL" && line.serialNumbers?.length) {
            for (const sn of line.serialNumbers) {
              const serialId = serialMap.get(sn);
              acceptedMovements.push({
                transactionType: "GRN",
                productVariantId: poLine.productVariantId,
                locationId,
                lotId: undefined,
                serialId,
                quantityDelta: "1.0000",
                unitCost: poLine.unitCost ?? undefined,
              });
            }
          } else {
            const lotKey =
              trackingMethod === "LOT" && line.lotNumber
                ? `${poLine.productVariantId}:${line.lotNumber}`
                : undefined;
            const lotId = lotKey ? lotMap.get(lotKey) : undefined;

            acceptedMovements.push({
              transactionType: "GRN",
              productVariantId: poLine.productVariantId,
              locationId,
              lotId,
              serialId: undefined,
              quantityDelta: Number(line.quantityReceived).toFixed(4),
              unitCost: poLine.unitCost ?? undefined,
            });
          }
        }
      }

      const allLines = await tx.query.invPoLines.findMany({
        where: eq(invPoLines.poId, poId),
      });
      const allReceived = allLines.every(
        (l) => parseFloat(l.quantityReceived) >= parseFloat(l.quantity),
      );
      await tx
        .update(invPurchaseOrders)
        .set({
          status: allReceived ? "RECEIVED" : "PARTIAL",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(invPurchaseOrders.id, poId),
            eq(invPurchaseOrders.orgId, orgId),
          ),
        );

      if (acceptedMovements.length > 0) {
        await this.engine.executeInTx(tx, orgId, userId, {
          idempotencyKey,
          sourceType: "inv_grn",
          sourceId: String(grn.id),
          reason: `GRN: ${grnNumber}`,
          movements: acceptedMovements,
        });
      }

      // Goods-received accrual, on the SAME transaction as the movement it
      // values (ACC-05). Accounting resolves the accounts from the org's own
      // chart via system tags — which is what INV-09's per-organisation mapping
      // becomes on the kernel — and a redelivered receipt is idempotent on the
      // GRN id (`stock_move:{grnId}:receive`).
      //
      // Inside, not after the commit. A refusal — a missing account role, a
      // locked period — now rolls the receipt back with it instead of leaving
      // a committed GRN the ledger never heard about, which is the 500-after-
      // commit this path used to give. The one expected absence, an org that
      // never enabled accounting, is `BOOK_NOT_ENABLED` and is skipped.
      //
      // Exact, not float: `quantity * parseFloat(unitCost)` is the arithmetic
      // the PRD forbids for money, and this figure lands on both sides of the
      // journal. It credits `ap_control`, as the kernel's receiving post does
      // today. The inventory lane named this line GRNI (whose default account
      // was AP's); moving it onto the kernel's `grni` role is the contract's
      // §2.2 / ACC-03 decision, not this merge's.
      let receivedValue = "0.0000";
      for (const line of data.lines) {
        if (line.qualityStatus !== "ACCEPTED") continue;
        const poLine = po.lines.find((l) => l.id === line.poLineId);
        if (!poLine) continue;
        receivedValue = addDec(receivedValue, mulDec(String(line.quantityReceived), poLine.unitCost ?? "0"));
      }
      const totalMinor = isPositive(receivedValue) ? Math.round(Number(receivedValue) * 100) : 0;
      if (totalMinor > 0) {
        await this.postReceipt(orgId, userId, tx, {
          grnId: grn.id,
          grnNumber,
          poNumber: po.poNumber,
          receivedDate: data.receivedDate,
          totalMinor,
        });
      }

      return grn.id;
    });

    await this.engine.invalidateCaches(orgId);

    if (settings.inspectionOnReceipt) {
      const inspNumber = await this.numSeq.next(orgId, "INSPECTION");
      await this.db.insert(invQualityInspections).values({
        orgId,
        inspectionNumber: inspNumber,
        sourceType: "inv_grn",
        sourceId: String(grnId),
        status: "PENDING",
        createdBy: userId,
      });
    }

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, poId));
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.invGrnNamespace(orgId)),
    ]);

    return this.db.query.invGrns.findFirst({
      where: eq(invGrns.id, grnId),
      with: { lines: true, creator: { columns: { id: true, name: true } } },
    });
  }

  /**
   * Accounting is opt-in. An org that never enabled it has no book to post
   * into, and that must not fail a goods receipt — every other rejection (a
   * missing account role, a locked period, an unbalanced total) still surfaces
   * loudly, and on the receipt's own transaction it takes the receipt with it.
   * See `docs/inventory-gl-contract.md` §3.3/§4.
   */
  private async postReceipt(
    orgId: string,
    userId: string,
    tx: DbOrTx,
    receipt: { grnId: number; grnNumber: string; poNumber: string; receivedDate: string; totalMinor: number },
  ): Promise<void> {
    try {
      await this.posting.submit(
        orgId,
        userId,
        {
          sourceType: "stock_move",
          sourceId: String(receipt.grnId),
          purpose: "receive",
          journalDate: receipt.receivedDate,
          memo: `Goods received: ${receipt.grnNumber}`,
          lines: [
            {
              accountTag: "inventory",
              debitMinor: receipt.totalMinor,
              description: `Inventory received - ${receipt.grnNumber}`,
            },
            {
              accountTag: "ap_control",
              creditMinor: receipt.totalMinor,
              description: `AP - PO ${receipt.poNumber}`,
            },
          ],
        },
        tx,
      );
    } catch (error) {
      if (error instanceof AdapterRejection && error.code === "BOOK_NOT_ENABLED") {
        this.logger.debug(
          `Accounting is not enabled for org ${orgId}; GRN ${receipt.grnNumber} was not posted`,
        );
        return;
      }
      throw error;
    }
  }
}
