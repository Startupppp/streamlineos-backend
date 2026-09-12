/**
 * The shapes `ArReceiptsService` returns, and the settlement source it hands
 * down to `lib/ar-receipt-settlement.ts`.
 */

export interface ArAllocationView {
  id: string;
  documentId: string;
  documentNumber: string | null;
  amountMinor: number;
  createdAt: Date;
}

export interface ArReceiptView {
  id: string;
  bookId: string;
  partyId: string;
  receiptNumber: string | null;
  receiptDate: string;
  depositAccountId: string;
  currency: string;
  fxRate: string;
  amountMinor: number;
  unappliedMinor: number;
  appliedMinor: number;
  status: "POSTED" | "REVERSED";
  paymentMethod: string | null;
  reference: string | null;
  memo: string | null;
  postedJournalId: string | null;
  reversalJournalId: string | null;
  allocations: ArAllocationView[];
}

export interface ArReceiptPage {
  items: Omit<ArReceiptView, "allocations">[];
  page: number;
  pageSize: number;
  total: number;
}

/** Where a settlement is coming from. Exactly one of the two, never both. */
export type AllocationSource =
  | { kind: "receipt"; id: string; partyId: string; currency: string; availableMinor: number }
  | { kind: "credit_note"; id: string; partyId: string; currency: string; availableMinor: number };
