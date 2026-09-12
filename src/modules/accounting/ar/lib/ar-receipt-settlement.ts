/**
 * Settling open invoices from a receipt or a credit note, and unwinding a
 * receipt's settlements when it is reversed.
 *
 * An allocation moves no money — both legs already hit AR control when the
 * invoice and the receipt posted — so everything here writes settlement rows
 * and document balances on the caller's transaction, and never a journal.
 */
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { arAllocations, arDocuments, arReceipts } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";
import type { AllocationLineInput } from "../dto/ar-receipts.schemas";
import type { AllocationSource } from "../ar-receipts.types";
import { OPEN_STATUSES, loadReceipt, lockDocument, lockReceipt, statusFor } from "./ar-receipt-rows";

export async function applyAllocations(
  orgId: string,
  userId: string | null,
  receiptId: string,
  allocations: readonly AllocationLineInput[],
  tx: DbOrTx,
): Promise<number> {
  const receipt = await lockReceipt(orgId, receiptId, tx);
  if (receipt.status !== "POSTED") {
    throw new ConflictException("A reversed receipt cannot be allocated");
  }

  const source: AllocationSource = {
    kind: "receipt",
    id: receipt.id,
    partyId: receipt.partyId,
    currency: receipt.currency,
    availableMinor: receipt.unappliedMinor,
  };
  const applied = await settle(orgId, userId, receipt.bookId, source, allocations, tx);

  await tx
    .update(arReceipts)
    .set({ unappliedMinor: receipt.unappliedMinor - applied })
    .where(and(eq(arReceipts.orgId, orgId), eq(arReceipts.id, receiptId)));

  return applied;
}

export async function applyFifo(
  orgId: string,
  userId: string | null,
  receiptId: string,
  maxAmountMinor: number | undefined,
  tx: DbOrTx,
): Promise<number> {
  const receipt = await loadReceipt(orgId, receiptId, tx);
  let remaining = Math.min(receipt.unappliedMinor, maxAmountMinor ?? receipt.unappliedMinor);
  if (remaining <= 0) return 0;

  const open = await tx
    .select({
      id: arDocuments.id,
      grossMinor: arDocuments.grossMinor,
      settledMinor: arDocuments.settledMinor,
    })
    .from(arDocuments)
    .where(
      and(
        eq(arDocuments.orgId, orgId),
        eq(arDocuments.bookId, receipt.bookId),
        eq(arDocuments.partyId, receipt.partyId),
        eq(arDocuments.documentType, "INVOICE"),
        eq(arDocuments.currency, receipt.currency),
        inArray(arDocuments.status, OPEN_STATUSES),
        isNull(arDocuments.deletedAt),
        sql`${arDocuments.grossMinor} > ${arDocuments.settledMinor}`,
      ),
    )
    // Oldest due date first; an invoice with no due date ages from its issue.
    .orderBy(
      asc(sql`coalesce(${arDocuments.dueDate}, ${arDocuments.issueDate})`),
      asc(arDocuments.issueDate),
      asc(arDocuments.id),
    );

  const allocations: AllocationLineInput[] = [];
  for (const doc of open) {
    if (remaining <= 0) break;
    const amountMinor = Math.min(remaining, doc.grossMinor - doc.settledMinor);
    if (amountMinor <= 0) continue;
    allocations.push({ documentId: doc.id, amountMinor });
    remaining -= amountMinor;
  }

  if (allocations.length === 0) return 0;
  return applyAllocations(orgId, userId, receiptId, allocations, tx);
}

/**
 * The shared settlement path for both sources.
 *
 * Targets are locked in id order so two receipts landing on the same pair of
 * invoices cannot deadlock, and every amount is checked against both the
 * invoice's open balance and the source's remaining balance before anything
 * is written.
 */
export async function settle(
  orgId: string,
  userId: string | null,
  bookId: string,
  source: AllocationSource,
  allocations: readonly AllocationLineInput[],
  tx: DbOrTx,
): Promise<number> {
  if (allocations.length === 0) return 0;

  const merged = new Map<string, number>();
  for (const allocation of allocations) {
    merged.set(
      allocation.documentId,
      (merged.get(allocation.documentId) ?? 0) + allocation.amountMinor,
    );
  }

  const total = [...merged.values()].reduce((a, b) => a + b, 0);
  if (total > source.availableMinor) {
    throw new BadRequestException(
      `Cannot allocate ${total} against an unapplied balance of ${source.availableMinor}`,
    );
  }

  for (const documentId of [...merged.keys()].sort()) {
    const amountMinor = merged.get(documentId)!;
    const target = await lockDocument(orgId, documentId, tx);

    if (target.bookId !== bookId) throw new NotFoundException("Document not found");
    if (target.documentType !== "INVOICE") {
      throw new BadRequestException("Only an invoice can be settled");
    }
    if (target.id === source.id) {
      throw new BadRequestException("A document cannot settle itself");
    }
    if (target.partyId !== source.partyId) {
      throw new BadRequestException(
        "A receipt can only be applied to the same customer's invoices",
      );
    }
    if (target.currency !== source.currency) {
      throw new BadRequestException(
        `Currency mismatch: ${source.currency} cannot settle a ${target.currency} invoice`,
      );
    }
    if (!OPEN_STATUSES.includes(target.status)) {
      throw new ConflictException(
        `Invoice ${target.documentNumber ?? target.id} is ${target.status} and is not open`,
      );
    }

    const openMinor = target.grossMinor - target.settledMinor;
    if (amountMinor > openMinor) {
      throw new BadRequestException(
        `Cannot allocate ${amountMinor} to ${target.documentNumber ?? target.id}; ` +
          `only ${openMinor} is open`,
      );
    }

    await tx
      .insert(arAllocations)
      .values({
        orgId,
        bookId,
        receiptId: source.kind === "receipt" ? source.id : null,
        creditNoteId: source.kind === "credit_note" ? source.id : null,
        documentId,
        amountMinor,
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target:
          source.kind === "receipt"
            ? [arAllocations.receiptId, arAllocations.documentId]
            : [arAllocations.creditNoteId, arAllocations.documentId],
        targetWhere:
          source.kind === "receipt"
            ? sql`${arAllocations.receiptId} IS NOT NULL`
            : sql`${arAllocations.creditNoteId} IS NOT NULL`,
        set: { amountMinor: sql`${arAllocations.amountMinor} + ${amountMinor}` },
      });

    const settled = target.settledMinor + amountMinor;
    await tx
      .update(arDocuments)
      .set({ settledMinor: settled, status: statusFor(settled, target.grossMinor) })
      .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, documentId)));
  }

  return total;
}

/**
 * Give back everything a receipt settled: each invoice's settled amount drops
 * by that receipt's allocation and its status follows, then the receipt's
 * allocation rows are deleted. The reversal's half of `reverseReceipt`.
 */
export async function unwindReceiptAllocations(
  orgId: string,
  receiptId: string,
  tx: DbOrTx,
): Promise<void> {
  const existing = await tx
    .select({
      documentId: arAllocations.documentId,
      amountMinor: arAllocations.amountMinor,
    })
    .from(arAllocations)
    .where(eq(arAllocations.receiptId, receiptId));

  for (const allocation of [...existing].sort((a, b) =>
    a.documentId.localeCompare(b.documentId),
  )) {
    const target = await lockDocument(orgId, allocation.documentId, tx);
    const settled = Math.max(0, target.settledMinor - allocation.amountMinor);
    await tx
      .update(arDocuments)
      .set({ settledMinor: settled, status: statusFor(settled, target.grossMinor) })
      .where(and(eq(arDocuments.orgId, orgId), eq(arDocuments.id, allocation.documentId)));
  }

  await tx.delete(arAllocations).where(eq(arAllocations.receiptId, receiptId));
}
