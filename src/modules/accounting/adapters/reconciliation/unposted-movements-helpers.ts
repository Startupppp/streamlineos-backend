export type UnpostedReason =
  /** No bridge call site posts for this kind of movement at all. */
  | "no_posting_path"
  /** A kind that does post, where the journal is missing. */
  | "post_missing"
  /**
   * A movement that is deliberately not posted, per the treatment map: a
   * quarantine, a reservation, an opening-stock import. Reported so the number
   * can be seen and dismissed, never counted as a gap — a report that called
   * these a hole would cry wolf, and the next real gap would be ignored with
   * them.
   */
  | "not_applicable";

export interface UnpostedMovement {
  transactionId: number;
  postingDate: string | null;
  transactionType: string;
  referenceType: string | null;
  referenceId: string | null;
  valueMinor: number;
  reason: UnpostedReason;
}

export function group<T>(rows: T[], key: (row: T) => string): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

/**
 * Say what the numbers do and do not mean, in the payload rather than in a
 * wiki. A reconciliation report that overstates its own precision is worse than
 * none, because it gets trusted.
 */
export function notesFor(unposted: UnpostedMovement[]): string[] {
  const notes: string[] = [];

  if (unposted.some((m) => m.reason === "no_posting_path")) {
    notes.push(
      "Movements marked no_posting_path reach the stock ledger through a document type " +
        "accounting does not know how to post. Adjustments, transfers, counts, quality " +
        "write-offs and both kinds of return all have a posting path now (ACC-21), so " +
        "anything left under this reason is a document type added since — a gap to close, " +
        "not a setting to change.",
    );
  }
  if (unposted.some((m) => m.reason === "not_applicable")) {
    notes.push(
      "Movements marked not_applicable are deliberately unposted and are excluded from the " +
        "totals above. A quality hold moves stock between buckets and a reservation promises " +
        "it, and in both cases the business owns the goods throughout, so there is no journal " +
        "to be missing; opening-stock imports are answered by the opening trial balance " +
        "entered in accounting rather than here.",
    );
  }
  if (unposted.some((m) => m.reason === "post_missing")) {
    notes.push(
      "Movements marked post_missing had a posting path and no journal. That should not " +
        "happen — the post shares the movement's own transaction — so treat each one as a " +
        "bug to investigate rather than a setting to change.",
    );
  }
  /*
    Stated always, because it bounds every figure above. A shipment's stock
    transaction records the SALES ORDER as its reference and never the
    shipment, so a partially shipped order whose first shipment posted cannot
    be distinguished from one whose second shipment did not.
  */
  notes.push(
    "Shipments are matched at sales-order level: a stock transaction records the sales " +
      "order as its reference and never the shipment, so on a partially shipped order one " +
      "posted shipment makes the whole order look posted.",
  );
  return notes;
}
