import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { invLots, invSerialNumbers } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import { cmpDec } from "../../stock-engine/decimal";
import { INV_ERRORS } from "../../stock-engine/stock-engine.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The lot fields a receipt line carries until it posts. */
export interface ReceiptLotDraft {
  lotNumber: string | null;
  expiryDate: string | null;
  manufactureDate: string | null;
  /**
   * E3. The MRP printed on the cartons, in integer paise, as recorded on the
   * receipt line. Optional because only the `pharmacy` pack captures it.
   */
  mrpPaise?: number | null;
}

/** The serial fields, likewise. */
export interface ReceiptSerialDraft {
  poLineId: number;
  quantityReceived: string;
  serials: ReadonlyArray<{ serialNumber: string }>;
}

/**
 * B1, item 4 — an expired batch is refused at the door when the policy is BLOCK.
 *
 * The allocator has always refused to *ship* an expired lot; nothing refused to
 * receive one, so expired goods entered stock and were then permanently
 * unsellable — a write-off that surfaces months later as a valuation mystery.
 * The comparison is `<=` and against the receipt's own date rather than today,
 * matching `so-lifecycle`: a lot that expires on the day it arrives is expired.
 */
export async function assertLotAcceptable(
  tx: Tx,
  orgId: string,
  line: ReceiptLotDraft,
  productVariantId: number,
  receivedDate: string,
  expiryPolicy: string,
): Promise<void> {
  if (expiryPolicy !== "BLOCK") return;
  if (!line.lotNumber && line.expiryDate === null) return;

  let expiryDate = line.expiryDate;
  if (expiryDate === null && line.lotNumber) {
    // A lot number we already know carries its own expiry, and a receipt that
    // did not restate it is still receiving that batch.
    const existing = await tx.query.invLots.findFirst({
      where: and(
        eq(invLots.orgId, orgId),
        eq(invLots.productVariantId, productVariantId),
        eq(invLots.lotNumber, line.lotNumber),
      ),
      columns: { expiryDate: true },
    });
    expiryDate = existing?.expiryDate ?? null;
  }

  if (expiryDate !== null && expiryDate <= receivedDate) {
    throw new BadRequestException({
      code: INV_ERRORS.LOT_EXPIRED,
      message: `Lot ${line.lotNumber ?? ""} expired on ${expiryDate} and cannot be received on ${receivedDate}`,
    });
  }
}

/** One serial per unit, and none of them already owned by this organisation. */
export async function assertSerialsAcceptable(
  tx: Tx,
  orgId: string,
  line: ReceiptSerialDraft,
  productVariantId: number,
): Promise<void> {
  const serials = line.serials.map((s) => s.serialNumber);
  if (cmpDec(String(serials.length), line.quantityReceived) !== 0) {
    throw new BadRequestException(
      `Line ${line.poLineId}: SERIAL-tracked product requires ${line.quantityReceived} serial numbers, got ${serials.length}`,
    );
  }
  if (serials.length === 0) return;

  const existing = await tx.query.invSerialNumbers.findMany({
    where: and(
      eq(invSerialNumbers.orgId, orgId),
      eq(invSerialNumbers.productVariantId, productVariantId),
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

/** Finds or opens the batch the counter wrote on the line. */
export async function resolveLotId(
  tx: Tx,
  orgId: string,
  productVariantId: number,
  line: ReceiptLotDraft,
): Promise<number | undefined> {
  if (!line.lotNumber) return undefined;
  const existing = await tx.query.invLots.findFirst({
    where: and(
      eq(invLots.orgId, orgId),
      eq(invLots.productVariantId, productVariantId),
      eq(invLots.lotNumber, line.lotNumber),
    ),
    columns: { id: true },
  });
  if (existing) return existing.id;

  const [created] = await tx
    .insert(invLots)
    .values({
      orgId,
      status: "ACTIVE",
      lotNumber: line.lotNumber,
      expiryDate: line.expiryDate,
      manufactureDate: line.manufactureDate,
      /**
       * E3. The snapshot, taken here and never updated. The ceiling that binds a
       * sale is the one printed on the pack in the customer's hand, so it is a
       * fact about this batch — two batches of one medicine on one shelf
       * routinely carry different MRPs, and the older may not be sold at the
       * newer's price. An existing lot keeps the MRP it was received with; a
       * re-print arrives as a new batch number.
       */
      mrpPaise: line.mrpPaise ?? null,
      productVariantId,
    })
    .returning({ id: invLots.id });
  return created?.id;
}

/** Brings each scanned unit into stock, creating the ones we have never seen. */
export async function resolveSerialIds(
  tx: Tx,
  orgId: string,
  productVariantId: number,
  locationId: number,
  lotId: number | undefined,
  serials: readonly string[],
): Promise<number[]> {
  if (serials.length === 0) return [];

  const resolved: number[] = [];
  const existing = await tx.query.invSerialNumbers.findMany({
    where: and(
      eq(invSerialNumbers.orgId, orgId),
      eq(invSerialNumbers.productVariantId, productVariantId),
      inArray(invSerialNumbers.serialNumber, [...serials]),
    ),
    columns: { id: true, serialNumber: true },
  });
  if (existing.length > 0) {
    await tx
      .update(invSerialNumbers)
      .set({ status: "IN_STOCK", currentLocationId: locationId })
      .where(inArray(invSerialNumbers.id, existing.map((s) => s.id)));
    for (const s of existing) resolved.push(s.id);
  }

  const known = new Set(existing.map((s) => s.serialNumber));
  const toInsert = serials.filter((sn) => !known.has(sn));
  if (toInsert.length > 0) {
    const inserted = await tx
      .insert(invSerialNumbers)
      .values(
        toInsert.map((serialNumber) => ({
          orgId,
          serialNumber,
          lotId,
          status: "IN_STOCK" as const,
          currentLocationId: locationId,
          productVariantId,
        })),
      )
      .returning({ id: invSerialNumbers.id });
    for (const row of inserted) resolved.push(row.id);
  }

  return resolved;
}
