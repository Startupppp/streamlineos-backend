import { randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  invPurchaseOrders,
  invPoLines,
  invGrns,
  invGrnLines,
  invLots,
  invSerialNumbers,
  invQualityInspections,
  invStockTransactions,
  invLocations,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { WarehouseScopeService } from "../stock-engine/warehouse-scope.service";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { addDec, cmpDec, divDec, mulDec, subDec, isPositive } from "../stock-engine/decimal";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { NumberSequenceService } from "../stock-engine/number-sequence.service";
import { INV_ERRORS } from "../stock-engine/stock-engine.types";
import { runIdempotent, revivedId } from "../stock-engine/idempotency";
import { InventoryAccountingBridge } from "../stock-engine/accounting-bridge";
import type {
  CreateGrnInput,
  ListGrnInput,
  ReverseGrnInput,
} from "./dto/inv-purchase-orders.schemas";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { PoService } from "./po.service";
import { StockProjectionService } from "../stock-engine/stock-projection.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class GrnService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly engine: StockEngineService,
    private readonly settingsService: InventorySettingsService,
    private readonly numSeq: NumberSequenceService,
    private readonly journalPosting: InventoryAccountingBridge,
    private readonly poService: PoService,
    private readonly warehouseScope: WarehouseScopeService,
    private readonly projection: StockProjectionService,
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

    /**
     * A3. The whole receipt, as one claimable unit.
     *
     * The key used to reach only the engine call, and the engine call is
     * conditional: a delivery whose every line is REJECTED produces no
     * movements, so that branch claimed nothing at all and a retry raised a
     * second GRN, decremented `on_order` twice and added the same quantity to
     * `inv_po_lines.quantity_received` a second time -- closing a purchase
     * order as RECEIVED against goods nobody accepted.
     *
     * Where movements did exist the retry was refused rather than replayed,
     * and only by accident: the engine hashes the command, the command carries
     * the new GRN's id, so an identical retry looked like a *different*
     * request and got 422. Correct by luck, and the wrong error.
     *
     * Everything the receipt does now sits inside one claim -- the document,
     * the PO arithmetic, the movement, the outbox event, the journal entry and
     * the inspection -- on the caller's transaction, so the claim cannot commit
     * over work that rolled back. The engine gets a derived key because the
     * same key claimed twice in one transaction is a duplicate, not a nesting.
     */
    const receipt = async (outerTx: Tx): Promise<number> => {
      const grnNumber = await this.numSeq.next(orgId, "GRN", outerTx);


      const lotMap = new Map<string, number>();
      const serialMap = new Map<string, number>();

      const createdGrnId = await outerTx.transaction(async (tx) => {
        // What each line owed at receipt time, computed under the row lock in the
        // validation pass and carried to the insert pass so both agree. Recomputing
        // it later would read a total the first pass has already moved.
        const expectedByLine = new Map<
          number,
          { expected: string; discrepancyReason: "SHORT" | "OVER" | "DAMAGED" | "WRONG_ITEM" | null }
        >();
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

          // Exact throughout. The old form parsed both sides to floats, added an
          // 0.0001 epsilon to paper over the comparison, and then posted
          // `toFixed(4)` of a float into the stock ledger.
          const remaining = subDec(
            String(lockedLine.quantity),
            String(lockedLine.quantity_received),
          );
          const maxAllowed = addDec(
            remaining,
            mulDec(remaining, divDec(settings.overReceiptTolerancePct, "100")),
          );

          if (cmpDec(line.quantityReceived, maxAllowed) > 0) {
            throw new BadRequestException(
              `Line ${line.poLineId}: received qty ${line.quantityReceived} exceeds allowed max ${maxAllowed} (over-receipt tolerance ${settings.overReceiptTolerancePct}%)`,
            );
          }

          // The receipt records what the line still owed at this moment, so a
          // short delivery stays legible after the purchase order moves on. An
          // over-receipt is exceptional by definition -- it only got here by
          // passing the tolerance gate above -- so it is labelled even when the
          // receiver did not say why.
          const overReceipt = cmpDec(line.quantityReceived, remaining) > 0;
          expectedByLine.set(line.poLineId, {
            expected: remaining,
            discrepancyReason:
              line.discrepancyReason ?? (overReceipt ? ("OVER" as const) : null),
          });

          if (trackingMethod === "SERIAL") {
            const serials = line.serialNumbers ?? [];
            if (cmpDec(String(serials.length), line.quantityReceived) !== 0) {
              throw new BadRequestException(
                `Line ${line.poLineId}: SERIAL-tracked product requires ${line.quantityReceived} serial numbers, got ${serials.length}`,
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
            quantityReceived: line.quantityReceived,
            quantityExpected: expectedByLine.get(line.poLineId)?.expected ?? null,
            discrepancyReason:
              expectedByLine.get(line.poLineId)?.discrepancyReason ?? null,
            qualityStatus: line.qualityStatus,
            rejectionReason: line.rejectionReason,
          });

          // A1. Goods that have arrived are no longer on order. Without this the
          // bucket only ever grows, and replenishment sees a permanent phantom
          // inbound that suppresses every future proposal.
          if (po.warehouseId !== null) {
            await this.projection.addOnOrder(
              tx,
              orgId,
              poLine.productVariantId,
              po.warehouseId,
              `-${line.quantityReceived}`,
            );
          }

          await tx
            .update(invPoLines)
            .set({
              quantityReceived: sql`${invPoLines.quantityReceived} + ${line.quantityReceived}::numeric`,
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
                quantityDelta: line.quantityReceived,
                unitCost: poLine.unitCost ?? undefined,
              });
            }
          }
        }

        const allLines = await tx.query.invPoLines.findMany({
          where: eq(invPoLines.poId, poId),
        });
        const allReceived = allLines.every(
          (l) => cmpDec(l.quantityReceived, l.quantity) >= 0,
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
            idempotencyKey: `${idempotencyKey}:stock`,
            sourceType: "inv_grn",
            sourceId: String(grn.id),
            reason: `GRN: ${grnNumber}`,
            movements: acceptedMovements,
          });
        }

        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "inv_purchase_order",
          aggregateId: String(poId),
          aggregateVersion: Date.now(),
          eventType: "inventory.purchase_order.received",
          payload: {
            poId,
            poNumber: po.poNumber,
            grnId: grn.id,
            grnNumber,
            lineCount: data.lines.length,
            actorUserId: userId,
          },
          occurredAt: new Date(),
        });

        return grn.id;
      });

      await this.engine.invalidateCaches(orgId);

      const acceptedLines = data.lines.filter(
        (l) => l.qualityStatus === "ACCEPTED",
      );

      // Exact, not float. `quantity * parseFloat(unitCost)` is the arithmetic the
      // PRD forbids outright for money, and this figure is what lands on both
      // sides of a journal entry — a rounding error here is an unbalanced ledger.
      let totalValueDec = "0.0000";
      for (const line of acceptedLines) {
        const poLine = po.lines.find((l) => l.id === line.poLineId)!;
        totalValueDec = addDec(totalValueDec, mulDec(line.quantityReceived, poLine.unitCost));
      }
      const totalValue = Number(totalValueDec);

      if (isPositive(totalValueDec)) {
        await this.journalPosting.postJournalEntry({
          orgId,
          entryDate: data.receivedDate,
          description: `Goods received: ${grnNumber}`,
          sourceType: "inv_grn",
          sourceId: String(createdGrnId),
          sourceEvent: "receive",
          status: "POSTED",
          createdBy: userId,
          lines: [
            {
              credit: 0,
              debit: totalValue,
              accountCode: "1300",
              description: `Inventory received - ${grnNumber}`,
            },
            {
              accountCode: "2000",
              debit: 0,
              credit: totalValue,
              description: `AP - PO ${po.poNumber}`,
            },
          ],
        });
      }

      if (settings.inspectionOnReceipt) {
        const inspNumber = await this.numSeq.next(orgId, "INSPECTION");
        await this.db.insert(invQualityInspections).values({
          orgId,
          inspectionNumber: inspNumber,
          sourceType: "inv_grn",
          sourceId: String(createdGrnId),
          status: "PENDING",
          createdBy: userId,
        });
      }

      return createdGrnId;
    };

    const grnId = await this.db.transaction(async (tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { poId, locationId, receivedDate: data.receivedDate, notes: data.notes, lines: data.lines },
        () => receipt(tx),
        // The stored id has been through jsonb and may come back as a string,
        // so it is parsed rather than cast; a garbled row fails loudly here
        // instead of becoming a NaN lookup that finds nothing.
        (stored) => {
          const id = revivedId(stored);
          if (!Number.isInteger(id))
            throw new ConflictException("The stored result for this key is unreadable");
          return id;
        },
      ),
    );

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

  async listGrns(orgId: string, userId: string, filters: ListGrnInput) {
    const { poId, vendorId, dateFrom, dateTo, page, limit } = filters;
    const offset = (page - 1) * limit;
    const scope = await this.warehouseScope.forUser(orgId, userId);
    const hash = `${scope.key}:${poId ?? ""}:${vendorId ?? ""}:${dateFrom ?? ""}:${dateTo ?? ""}:${limit}:${offset}`;

    return this.cache.cachedVersioned(
      CACHE_KEYS.invGrnNamespace(orgId),
      hash,
      async () => {
        const conditions = [eq(invGrns.orgId, orgId), scope.location(sql`${invGrns.locationId}`)];
        if (poId) conditions.push(eq(invGrns.poId, poId));
        if (dateFrom) conditions.push(gte(invGrns.receivedDate, dateFrom));
        if (dateTo) conditions.push(lte(invGrns.receivedDate, dateTo));

        if (vendorId) {
          const poIds = await this.db
            .select({ id: invPurchaseOrders.id })
            .from(invPurchaseOrders)
            .where(
              and(
                eq(invPurchaseOrders.orgId, orgId),
                eq(invPurchaseOrders.vendorId, vendorId),
              ),
            );
          if (poIds.length === 0)
            return { items: [], total: 0, page, totalPages: 0 };
          conditions.push(
            inArray(
              invGrns.poId,
              poIds.map((p) => p.id),
            ),
          );
        }

        const where = and(...conditions);

        const [items, countResult] = await Promise.all([
          this.db.query.invGrns.findMany({
            where,
            orderBy: [desc(invGrns.createdAt)],
            limit,
            offset,
            with: {
              purchaseOrder: {
                columns: { id: true, poNumber: true, vendorId: true },
                with: { vendor: { columns: { id: true, name: true } } },
              },
              creator: { columns: { id: true, name: true } },
            },
          }),
          this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(invGrns)
            .where(where),
        ]);

        return {
          items,
          total: countResult[0]?.count ?? 0,
          page,
          totalPages: Math.ceil((countResult[0]?.count ?? 0) / limit),
        };
      },
      CACHE_TTL.SHORT,
    );
  }

  async getGrn(orgId: string, grnId: number) {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      with: {
        lines: true,
        purchaseOrder: {
          columns: { id: true, poNumber: true, vendorId: true },
          with: { vendor: { columns: { id: true, name: true } } },
        },
        creator: { columns: { id: true, name: true } },
      },
    });
    if (!grn) throw new NotFoundException("GRN not found");
    return grn;
  }

  async reverseGrn(
    orgId: string,
    grnId: number,
    userId: string,
    idempotencyKey: string,
    data: ReverseGrnInput,
  ) {
    const grn = await this.db.query.invGrns.findFirst({
      where: and(eq(invGrns.id, grnId), eq(invGrns.orgId, orgId)),
      with: { lines: true },
    });
    if (!grn) throw new NotFoundException("GRN not found");

    const txns = await this.db.query.invStockTransactions.findMany({
      where: and(
        eq(invStockTransactions.orgId, orgId),
        eq(invStockTransactions.referenceType, "inv_grn"),
        eq(invStockTransactions.referenceId, String(grnId)),
      ),
    });

    if (txns.length === 0)
      throw new BadRequestException("No stock transactions found for this GRN");

    await this.db.transaction(async (tx) => {
      for (let i = 0; i < txns.length; i++) {
        const txn = txns[i]!;
        const reverseKey = `${idempotencyKey}:rev:${txn.id}`;
        await this.engine.reverseInTx(tx, orgId, userId, {
          idempotencyKey: reverseKey,
          stockTransactionId: txn.id,
          reason: data.reason,
        });
      }

      const po = await tx.query.invPurchaseOrders.findFirst({
        where: and(
          eq(invPurchaseOrders.id, grn.poId),
          eq(invPurchaseOrders.orgId, orgId),
        ),
        with: { lines: true },
      });

      if (po) {
        for (const grnLine of grn.lines) {
          await tx
            .update(invPoLines)
            .set({
              quantityReceived: sql`GREATEST(0, ${invPoLines.quantityReceived} - ${grnLine.quantityReceived})`,
            })
            .where(
              and(
                eq(invPoLines.id, grnLine.poLineId),
                eq(invPoLines.poId, po.id),
              ),
            );
        }

        const updatedLines = await tx.query.invPoLines.findMany({
          where: eq(invPoLines.poId, po.id),
        });
        const anyReceived = updatedLines.some(
          (l) => parseFloat(l.quantityReceived) > 0,
        );
        const newStatus = anyReceived ? "PARTIAL" : "SENT";

        await tx
          .update(invPurchaseOrders)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(
            and(
              eq(invPurchaseOrders.id, po.id),
              eq(invPurchaseOrders.orgId, orgId),
            ),
          );
      }

    });

    await this.engine.invalidateCaches(orgId);

    await this.cache.del(CACHE_KEYS.invPoDetail(orgId, grn.poId));
    await Promise.all([
      this.cache.invalidateNamespace(CACHE_KEYS.invPoNamespace(orgId)),
      this.cache.invalidateNamespace(CACHE_KEYS.invGrnNamespace(orgId)),
    ]);

    return { reversed: true, grnId, transactionCount: txns.length };
  }
}
