import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  invStockTransactions,
  invGrns,
  invPurchaseOrders,
  invVendors,
} from "../../../../db/schema";
import { type Db } from "../../../../db/drizzle.module";

/**
 * The receipt leg of a genealogy chain, and the ledger movements behind it.
 *
 * Grouped because `reversedTransactionIds` exists only for these two: a posted
 * stock movement can never be updated (the ledger trigger refuses it), so a
 * reversal is a SECOND row pointing back at the first, and both the receipt
 * list and the event list have to subtract them or a reversed receipt reads as
 * stock that arrived.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the
 * `so-ship.ts` shape: the DI graph and the caller are unchanged.
 */
/** What `StockEngineService` actually writes for a posted goods receipt. */
const GRN_REFERENCE_TYPE = "inv_grn";
const RECEIPT_LIMIT = 50;
const EVENT_LIMIT = 50;

export interface GenealogyReceiptDeps {
  readonly db: Db;
}

/**
 * D1. The receipts that put this lot on the shelf.
 *
 * This join used to match `reference_type = 'GRN'`, a value the stock engine
 * never writes — it writes `inv_grn` — and it never constrained the GRN to
 * the one the movement actually names. Had the literal matched, every ledger
 * row for the lot would have been paired with every GRN and every GRN line in
 * the organisation: a wrong answer and a cross product at the same time.
 *
 * Resolved in two bounded steps rather than a `reference_id::int` join,
 * because `reference_id` is free text shared with every other document type
 * and a cast the planner may hoist above the type filter fails the whole
 * query on the first non-numeric reference. `inv_grn_lines` is not consulted
 * at all: it carries a lot *number*, not a lot id, so it could never answer
 * "which line was this lot", and the ledger row already holds the quantity
 * that reached this lot — which is the truer figure anyway.
 */
export async function fetchReceipts(
  deps: GenealogyReceiptDeps,orgId: string, lotId: number) {
  const movements = await deps.db
    .select({
      transactionId: invStockTransactions.id,
      referenceId: invStockTransactions.referenceId,
      qtyReceived: invStockTransactions.quantityChange,
      receivedAt: invStockTransactions.createdAt,
      correctionOfTransactionId: invStockTransactions.correctionOfTransactionId,
    })
    .from(invStockTransactions)
    .where(
      and(
        eq(invStockTransactions.orgId, orgId),
        eq(invStockTransactions.lotId, lotId),
        eq(invStockTransactions.referenceType, GRN_REFERENCE_TYPE),
        isNotNull(invStockTransactions.referenceId),
      ),
    )
    .orderBy(desc(invStockTransactions.id))
    .limit(RECEIPT_LIMIT);
  if (movements.length === 0) return [];

  const grnIds = [
    ...new Set(
      movements.map((m) => Number(m.referenceId)).filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];
  if (grnIds.length === 0) return [];

  const [grns, reversedIds] = await Promise.all([
    deps.db
      .select({
        grnId: invGrns.id,
        grnNumber: invGrns.grnNumber,
        receivedDate: invGrns.receivedDate,
        poId: invPurchaseOrders.id,
        poNumber: invPurchaseOrders.poNumber,
        vendorId: invVendors.id,
        vendorName: invVendors.name,
        vendorCode: invVendors.code,
      })
      .from(invGrns)
      .innerJoin(invPurchaseOrders, eq(invGrns.poId, invPurchaseOrders.id))
      .innerJoin(invVendors, eq(invPurchaseOrders.vendorId, invVendors.id))
      .where(and(eq(invGrns.orgId, orgId), inArray(invGrns.id, grnIds))),
    reversedTransactionIds(deps, 
      orgId,
      movements.map((m) => m.transactionId),
    ),
  ]);
  const byId = new Map(grns.map((g) => [g.grnId, g]));

  return movements.flatMap((movement) => {
    const grn = byId.get(Number(movement.referenceId));
    if (!grn) return [];
    return [
      {
        ...grn,
        transactionId: movement.transactionId,
        qtyReceived: movement.qtyReceived,
        receivedAt: movement.receivedAt,
        // A2. A receipt that was reversed is not stock this lot ever held.
        reversed:
          movement.correctionOfTransactionId != null ||
          reversedIds.has(movement.transactionId),
      },
    ];
  });
}

export async function fetchEvents(
  deps: GenealogyReceiptDeps,orgId: string, lotId: number | undefined, serialId: number | undefined) {
  const condition = lotId != null
    ? and(eq(invStockTransactions.orgId, orgId), eq(invStockTransactions.lotId, lotId))
    : and(eq(invStockTransactions.orgId, orgId), eq(invStockTransactions.serialId, serialId!));

  const events = await deps.db.query.invStockTransactions.findMany({
    where: condition,
    orderBy: [desc(invStockTransactions.createdAt)],
    limit: EVENT_LIMIT,
    with: {
      location: { columns: { id: true, name: true, code: true } },
      creator: { columns: { id: true, name: true } },
    },
  });

  // A2. A movement that was compensated, and the compensation itself, are
  // both still facts of the ledger and both belong on the timeline — but a
  // reader who cannot tell them apart reads reversed goods as goods that
  // moved.
  const reversedIds = await reversedTransactionIds(deps, 
    orgId,
    events.map((e) => e.id),
  );
  return events.map((event) => ({
    ...event,
    reversed: event.correctionOfTransactionId != null || reversedIds.has(event.id),
  }));
}

/**
 * A2. Which of these movements has since been compensated.
 *
 * Answered from the partial unique index on
 * `(org_id, correction_of_transaction_id)`, so it is one bounded index probe
 * rather than a correlated `EXISTS` per row.
 */
async function reversedTransactionIds(
  deps: GenealogyReceiptDeps,
  orgId: string,
  transactionIds: readonly number[],
): Promise<Set<number>> {
  if (transactionIds.length === 0) return new Set();
  const rows = await deps.db
    .select({ correctionOf: invStockTransactions.correctionOfTransactionId })
    .from(invStockTransactions)
    .where(
      and(
        eq(invStockTransactions.orgId, orgId),
        inArray(invStockTransactions.correctionOfTransactionId, [...transactionIds]),
      ),
    );
  return new Set(rows.map((r) => r.correctionOf).filter((id): id is number => id != null));
}
