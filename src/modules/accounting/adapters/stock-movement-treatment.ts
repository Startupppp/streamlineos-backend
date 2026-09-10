import type { GlSystemTag } from "../../../db/schema";
import { invTxnTypeEnum } from "../../../db/schema/common/enums";

export type InvTxnType = (typeof invTxnTypeEnum.enumValues)[number];

/**
 * What each kind of stock movement does to the general ledger.
 *
 * `counterpart` means the movement changes the value of stock the business
 * owns: the inventory account takes the movement's own signed value and the
 * named role takes the other side. `none` means it does not, and the `why` is
 * required because "posts nothing" is the answer that has to survive somebody
 * later assuming it was an oversight — which is exactly how §3.4 of the
 * contract came to describe ten services as a single hole.
 *
 * Keyed on the enum, so it is exhaustive at compile time. A new movement type
 * cannot be added to inventory without someone deciding what it means to the
 * ledger, which is the property worth having: every gap this pack found began
 * as a movement nobody had thought about in accounting terms.
 */
export type MovementGlTreatment =
  | { kind: "counterpart"; role: GlSystemTag; why: string }
  | { kind: "none"; why: string };

export const MOVEMENT_GL_TREATMENT: Readonly<Record<InvTxnType, MovementGlTreatment>> = {
  /* ---- Value enters or leaves the business ------------------------------ */

  PURCHASE: {
    kind: "counterpart",
    role: "grni",
    why: "Goods received and not yet invoiced. Crediting ap_control instead puts a balance in the control account for which no bill exists (§2.2).",
  },
  GRN: {
    kind: "counterpart",
    role: "grni",
    why: "Same as PURCHASE. The receipt accrues and the bill drains it, so GRNI nets to zero per PO line and the AP control account only ever holds bills that exist.",
  },
  SALE: {
    kind: "counterpart",
    role: "cogs",
    why: "The cost of what shipped, recognised when it ships rather than when it is invoiced, so margin lands in the period the goods left.",
  },

  /* ---- Value is destroyed, found, or lost ------------------------------- */

  SCRAP: {
    kind: "counterpart",
    role: "inventory_write_off",
    why: "Deliberately destroyed stock. Separate from inventory_adjustment because a write-off is a decision somebody made and a count variance is a discovery.",
  },
  ADJUSTMENT_IN: {
    kind: "counterpart",
    role: "inventory_adjustment",
    why: "A manual correction upward. One account for both directions, so its balance is the period's net adjustment cost.",
  },
  ADJUSTMENT_OUT: {
    kind: "counterpart",
    role: "inventory_adjustment",
    why: "A manual correction downward. It shares an account with the upward case so the balance reads as the period NET adjustment, which is the number worth seeing on a P&L.",
  },
  CYCLE_COUNT_GAIN: {
    kind: "counterpart",
    role: "inventory_adjustment",
    why: "Stock found by a count. Real value, discovered rather than acquired.",
  },
  CYCLE_COUNT_LOSS: {
    kind: "counterpart",
    role: "inventory_adjustment",
    why: "Stock a count could not find. Shrinkage, and it belongs on the P&L in the period it was discovered.",
  },

  /* ---- Returns ---------------------------------------------------------- */

  CUSTOMER_RETURN: {
    kind: "counterpart",
    role: "cogs",
    why: "Goods coming back into stock reverse the cost of the sale that shipped them. Crediting cogs is what makes margin right for the period the return lands in.",
  },
  RETURN_IN: {
    kind: "counterpart",
    role: "cogs",
    why: "Same as CUSTOMER_RETURN, under the older type name. Both are live in the enum, so both must be answered.",
  },
  VENDOR_RETURN: {
    kind: "counterpart",
    role: "grni",
    why: "Goods going back to a supplier. It reverses the receipt accrual, so it must land where the receipt did — crediting inventory against ap_control would leave GRNI holding an accrual for goods no longer held.",
  },
  RETURN_OUT: {
    kind: "counterpart",
    role: "grni",
    why: "Same as VENDOR_RETURN, under the older type name. Both are live in the enum, so both must be answered.",
  },

  /* ---- Movements between places or buckets: value does not change -------- */

  TRANSFER_OUT: {
    kind: "counterpart",
    role: "inventory_adjustment",
    why: "A transfer's two legs net to zero against one inventory account, so a complete transfer posts nothing at all. The role is named for the case that does not net: goods dispatched and not received are shrinkage in transit, and that difference is exactly what reaches the ledger.",
  },
  TRANSFER_IN: {
    kind: "counterpart",
    role: "inventory_adjustment",
    why: "The receiving leg of the above. It carries the dispatched unit cost, so an intact transfer cancels its own outbound leg to the minor unit and writes no journal.",
  },
  QUARANTINE_IN: {
    kind: "none",
    why: "A quality hold blocks stock; it does not stop the business owning it. The goods are still an asset at the same cost, so the balance sheet must not move. (Inventory's own valuation does move here, and that is a defect in its costing, not a reason to post.)",
  },
  QUARANTINE_OUT: {
    kind: "none",
    why: "Releasing a hold, for the same reason. Note that inventory does not restore the cost layer it consumed on the way in, so its own valuation falls while the ledger correctly does not — that asymmetry is an inventory costing defect, reported not fixed.",
  },

  /* ---- Not movements at all --------------------------------------------- */

  OPENING_BALANCE: {
    kind: "none",
    why: "Opening stock is part of migrating onto the system, and its ledger counterpart is the opening trial balance the accountant enters at /accounting/opening-balances. Posting it here as well would double the inventory figure of every tenant that does both — which is every real migration.",
  },
  RESERVATION_CREATE: {
    kind: "none",
    why: "A reservation promises stock to an order. Nothing moves and nothing is owned differently.",
  },
  RESERVATION_RELEASE: {
    kind: "none",
    why: "As above. A released reservation returns a promise, not stock.",
  },
  RESERVATION_CONSUME: {
    kind: "none",
    why: "The shipment that consumes a reservation posts under SALE. Posting here as well would count the same goods twice.",
  },
};

/** The roles this map can ask for, for the provisioning check to require. */
export const MOVEMENT_COUNTERPART_ROLES: readonly GlSystemTag[] = [
  ...new Set(
    Object.values(MOVEMENT_GL_TREATMENT)
      .filter((t): t is Extract<MovementGlTreatment, { kind: "counterpart" }> => t.kind === "counterpart")
      .map((t) => t.role),
  ),
];
