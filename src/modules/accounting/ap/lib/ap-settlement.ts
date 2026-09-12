import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { apAllocations, apDocuments, type DocumentStatus } from "../../../../db/schema";
import type { DbOrTx } from "../../kernel/sequence.service";
import { isUniqueViolation } from "../ap.pg-errors";
import type { AllocationInput } from "../dto/ap-payments.schemas";

/**
 * Settling bills: which bills a payment or debit note may be applied to, the
 * allocation row that records each application, and the settled total and
 * status a bill derives from them. Everything runs on the caller's transaction.
 */

const SETTLEABLE: DocumentStatus[] = ["POSTED", "PARTIALLY_PAID", "PAID"];
export const OPEN_STATUSES: DocumentStatus[] = ["POSTED", "PARTIALLY_PAID"];

export interface AllocationTarget {
  id: string;
  netMinor: number;
  grossMinor: number;
  openMinor: number;
}

export async function writeAllocation(
  tx: DbOrTx,
  args: {
    orgId: string;
    bookId: string;
    paymentId: string | null;
    debitNoteId: string | null;
    documentId: string;
    amountMinor: number;
    userId: string | null;
  },
): Promise<void> {
  try {
    await tx.insert(apAllocations).values({
      orgId: args.orgId,
      bookId: args.bookId,
      paymentId: args.paymentId,
      debitNoteId: args.debitNoteId,
      documentId: args.documentId,
      amountMinor: args.amountMinor,
      createdBy: args.userId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictException(
        "That source is already applied to this bill. Reverse the existing allocation first.",
      );
    }
    throw error;
  }
}

/**
 * Move a document's settled total and let the status follow from it.
 *
 * Status is derived here rather than set by a caller, so "paid" can never
 * disagree with the allocations that are supposed to prove it.
 */
export async function applySettlement(
  tx: DbOrTx,
  orgId: string,
  documentId: string,
  deltaMinor: number,
): Promise<void> {
  const doc = await loadDocumentForUpdate(tx, orgId, documentId);
  if (!SETTLEABLE.includes(doc.status)) {
    throw new ConflictException(`A ${doc.status} document cannot be settled`);
  }

  const settledMinor = doc.settledMinor + deltaMinor;
  if (settledMinor < 0) {
    throw new BadRequestException("Unwinding more than was ever allocated to this document");
  }
  if (settledMinor > doc.grossMinor) {
    throw new BadRequestException(
      `Only ${doc.grossMinor - doc.settledMinor} is open on this document`,
    );
  }

  const status: DocumentStatus =
    settledMinor === 0 ? "POSTED" : settledMinor >= doc.grossMinor ? "PAID" : "PARTIALLY_PAID";

  await tx
    .update(apDocuments)
    .set({ settledMinor, status })
    .where(and(eq(apDocuments.orgId, orgId), eq(apDocuments.id, documentId)));
}

/**
 * The bills a payment or debit note may be applied to: same book, same
 * vendor, same currency, still open, and open for at least what is asked.
 */
export async function loadAllocationTargets(
  tx: DbOrTx,
  orgId: string,
  bookId: string,
  partyId: string,
  currency: string,
  allocations: readonly AllocationInput[],
): Promise<Map<string, AllocationTarget>> {
  if (allocations.length === 0) return new Map();
  const ids = [...new Set(allocations.map((a) => a.documentId))];
  if (ids.length !== allocations.length) {
    throw new BadRequestException("The same bill appears twice in the allocation list");
  }

  const rows = await tx
    .select({
      id: apDocuments.id,
      documentType: apDocuments.documentType,
      status: apDocuments.status,
      currency: apDocuments.currency,
      netMinor: apDocuments.netMinor,
      grossMinor: apDocuments.grossMinor,
      settledMinor: apDocuments.settledMinor,
    })
    .from(apDocuments)
    .where(
      and(
        eq(apDocuments.orgId, orgId),
        eq(apDocuments.bookId, bookId),
        eq(apDocuments.partyId, partyId),
        inArray(apDocuments.id, ids),
        isNull(apDocuments.deletedAt),
      ),
    );

  const byId = new Map(rows.map((r) => [r.id, r]));
  const targets = new Map<string, AllocationTarget>();

  for (const allocation of allocations) {
    const row = byId.get(allocation.documentId);
    if (!row) throw new NotFoundException("One of the bills was not found for this vendor");
    if (row.documentType !== "BILL") {
      throw new BadRequestException("Only a bill can be settled by a payment or debit note");
    }
    if (!OPEN_STATUSES.includes(row.status)) {
      throw new ConflictException(`Bill ${row.id} is ${row.status} and has nothing open`);
    }
    if (row.currency !== currency) {
      throw new BadRequestException(
        `Bill ${row.id} is in ${row.currency}; this settlement is in ${currency}`,
      );
    }
    const open = row.grossMinor - row.settledMinor;
    if (allocation.amountMinor > open) {
      throw new BadRequestException(
        `Bill ${row.id} has only ${open} open; ${allocation.amountMinor} was requested`,
      );
    }
    targets.set(row.id, {
      id: row.id,
      netMinor: row.netMinor,
      grossMinor: row.grossMinor,
      openMinor: open,
    });
  }
  return targets;
}

export async function loadDocumentForUpdate(tx: DbOrTx, orgId: string, documentId: string) {
  const [row] = await tx
    .select({
      id: apDocuments.id,
      bookId: apDocuments.bookId,
      partyId: apDocuments.partyId,
      documentType: apDocuments.documentType,
      status: apDocuments.status,
      currency: apDocuments.currency,
      netMinor: apDocuments.netMinor,
      grossMinor: apDocuments.grossMinor,
      settledMinor: apDocuments.settledMinor,
    })
    .from(apDocuments)
    .where(
      and(
        eq(apDocuments.orgId, orgId),
        eq(apDocuments.id, documentId),
        isNull(apDocuments.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundException("Document not found");
  return row;
}
