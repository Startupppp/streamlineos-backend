import type { ComplianceTransport } from "../../../../db/schema";

/**
 * What a document offers an authority, in the authority's terms.
 *
 * Deliberately small. An IRP wants the seller's GSTIN, the buyer's, the
 * document's number and date, and its totals; a Peppol network wants a
 * different envelope around much the same facts. Anything richer than this
 * would make the port a second copy of the invoice, and the first thing to rot
 * would be the copy.
 */
export interface CompliancePayload {
  documentType: string;
  documentId: string;
  documentNumber: string;
  documentDate: string;
  sellerTaxId: string;
  buyerTaxId: string | null;
  currency: string;
  totalMinor: number;
}

/**
 * What came back. Four outcomes, and the distinction between the last two is
 * the whole reason this is not a boolean.
 */
export type TransportResult =
  /** The authority took it and issued an identifier. The only filed outcome. */
  | { outcome: "accepted"; authorityId: string; ackNo: string; ackAt: Date }
  /** The authority looked at it and said no. Nothing to retry until it changes. */
  | { outcome: "rejected"; errors: Array<{ code: string; message: string }> }
  /**
   * The authority could not be reached, or answered something unreadable.
   * Distinct from `rejected` because the document may be perfectly valid, and
   * treating the two alike would either retry a rejection forever or abandon a
   * good invoice on a timeout.
   */
  | { outcome: "unavailable"; reason: string };

/**
 * The seam a real provider will implement.
 *
 * Two rules it exists to enforce, both of which the pack's honesty ratchets
 * check from the outside:
 *
 *  1. **Only an adapter may report a filing.** `ComplianceService` decides
 *     whether a document is reportable; it never claims one was reported. The
 *     only route from `pending` to `accepted` runs through a `TransportResult`
 *     that an adapter returned.
 *  2. **The transport a row records is the transport that handled it.** An
 *     adapter names its own `transport`, which is written onto the row, so a
 *     mock's work is labelled `mock_irp` in the database rather than in a
 *     deployment note that will not survive a restore.
 */
export interface ComplianceTransportAdapter {
  /** The enum member rows handled by this adapter carry. */
  readonly transport: ComplianceTransport;
  /** Human name for logs and for the honest empty state in the UI. */
  readonly name: string;
  /**
   * Whether this adapter would file for real. `false` means every
   * acknowledgement it produces is synthetic and must be presented as such.
   */
  readonly isReal: boolean;

  submit(payload: CompliancePayload): Promise<TransportResult>;
}

