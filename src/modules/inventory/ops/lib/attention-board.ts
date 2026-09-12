import {
  runAttentionProbes,
  RESERVATION_EXPIRY_WARNING_HOURS,
  TRANSIT_STALE_HOURS,
  type AttentionCounts,
  type AttentionProbeDeps,
} from "./attention-probes";

export type { AttentionProbeDeps as AttentionBoardDeps };

/**
 * B2 — one row of the Needs Attention board.
 *
 * Every card carries its own deep link, because a number a person cannot act on
 * is decoration. `href` is a route, not a page of results: the board's job is to
 * get somebody to the filtered list where the work is, and nothing more.
 */
export interface AttentionItem {
  /** Stable key, so the client can animate the list without reordering surprises. */
  key: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  count: number;
  href: string;
  /** The verb the operator would use next. Null when the link is the whole action. */
  actionLabel: string | null;
}

/**
 * A card is shown only when the count is genuinely above zero.
 *
 * `-1` means the probe failed. It is dropped rather than rendered as zero: a
 * board that quietly reports "no stockouts" because a query timed out is worse
 * than one that is a card short, because only the second is noticeable.
 */
function card(count: number, card: Omit<AttentionItem, "count">): AttentionItem | null {
  if (count <= 0) return null;
  return { ...card, count };
}

/**
 * Counts in, cards out — no database, no clock, no failure mode of its own.
 *
 * This half is where the copy and the ordering live, and it is deliberately
 * pure: everything that can fail happens in `runAttentionProbes`, and by the
 * time a count reaches here it is either a number somebody should act on or
 * the `-1` that means nobody found out.
 */
export function buildAttentionItems(counts: AttentionCounts): AttentionItem[] {
  const candidates: (AttentionItem | null)[] = [
    card(counts.outOfStock, {
      key: "out-of-stock",
      severity: "critical",
      title: "Out of stock",
      detail: "Active SKUs with nothing on hand. Orders for these are being refused now.",
      href: "/inventory/stock?stockStatus=out",
      actionLabel: "Create Purchase Order",
    }),
    card(counts.projectsAtRisk, {
      key: "projects-at-risk",
      severity: "critical",
      title: "Site requirements at risk",
      detail: "Material a site is waiting for that is short, with the date inside the lead time.",
      href: "/inventory/projects?risk=at-risk",
      actionLabel: "Reserve Stock",
    }),
    card(counts.negativeStock, {
      key: "negative-stock",
      severity: "critical",
      title: "Negative on-hand",
      detail: "The ledger says less than nothing is on the shelf. Count it before anything else.",
      href: "/inventory/reconciliation",
      actionLabel: "Start Cycle Count",
    }),
    card(counts.overCommitted, {
      key: "over-committed",
      severity: "critical",
      title: "Promised more than we hold",
      detail: "Reserved quantity exceeds on-hand at a bin — one of these promises will be broken.",
      href: "/inventory/reconciliation",
      actionLabel: "View Discrepancies",
    }),
    card(counts.reservationsExpired, {
      key: "reservations-expired",
      severity: "warning",
      title: "Reservations already expired",
      detail: "Holds past their expiry that nothing has released. This stock is unsellable and unused.",
      href: "/inventory/stock?tab=reservations&state=expired",
      actionLabel: "Release Reservation",
    }),
    card(counts.lowStock, {
      key: "low-stock",
      severity: "warning",
      title: "Low stock",
      detail: "At or below the reorder point. Buying has to start before these run out.",
      href: "/inventory/replenishment",
      actionLabel: "Review Reorder Suggestions",
    }),
    card(counts.transfersDelayed, {
      key: "transfers-delayed",
      severity: "warning",
      title: "Transfers still in transit",
      detail: `Dispatched more than ${TRANSIT_STALE_HOURS} hours ago and not received. The stock is in a van, not on a shelf.`,
      href: "/inventory/stock?tab=transfers&status=IN_TRANSIT",
      actionLabel: "Receive Transfer",
    }),
    card(counts.purchaseOrdersOpen, {
      key: "purchase-orders-open",
      severity: "warning",
      title: "Purchase orders not fully received",
      detail: "Sent or part-received orders still waiting on goods.",
      href: "/inventory/purchase-orders?status=SENT",
      actionLabel: "Receive Stock",
    }),
    card(counts.damaged, {
      key: "damaged-stock",
      severity: "warning",
      title: "Damaged stock in bins",
      detail: "Blocked quantity sitting in pickable locations. It needs writing off or returning.",
      href: "/inventory/stock?bucket=damaged",
      actionLabel: "Adjust Quantity",
    }),
    card(counts.quarantined, {
      key: "quarantined-stock",
      severity: "info",
      title: "Quarantined stock",
      detail: "Held pending a quality decision. Nothing can be promised from it until somebody rules.",
      href: "/inventory/quality",
      actionLabel: "Review Inspection",
    }),
    card(counts.reservationsExpiring, {
      key: "reservations-expiring",
      severity: "info",
      title: "Reservations expiring soon",
      detail: `Holds lapsing within ${RESERVATION_EXPIRY_WARNING_HOURS} hours. Confirm or extend them.`,
      href: "/inventory/stock?tab=reservations&state=expiring",
      actionLabel: null,
    }),
  ];

  const order = { critical: 0, warning: 1, info: 2 } as const;
  return candidates
    .filter((c): c is AttentionItem => c !== null)
    .sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

/**
 * B2 — the Needs Attention board.
 *
 * Every entry is something somebody has to decide about today. Counts only,
 * with a link to the list that holds the detail: a dashboard that tries to
 * carry the rows as well is a dashboard that loads slowly and is read rarely.
 */
export async function attentionBoard(
  deps: AttentionProbeDeps,
  orgId: string,
  userId: string,
): Promise<{ items: AttentionItem[]; generatedAt: string }> {
  const counts = await runAttentionProbes(deps, orgId, userId);
  return { items: buildAttentionItems(counts), generatedAt: new Date().toISOString() };
}
