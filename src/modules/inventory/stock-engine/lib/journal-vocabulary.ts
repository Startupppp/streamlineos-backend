import { UnprocessableEntityException } from "@nestjs/common";
import type { GlSystemTag } from "../../../../db/schema";
import { assertSafeMinor } from "../../../accounting/kernel/money";

/*
  What inventory says when it hands the ledger a journal: the purposes, the
  role each resolves to, the shape of a draft, and exact decimal-to-minor-unit
  conversion. Pure. InventoryAccountingBridge (../accounting-bridge.ts) is
  what posts, and it re-exports everything here.
*/

/**
 * INV-09 — every purpose inventory names when it hands the ledger a journal, and
 * nothing else.
 *
 * Purposes are inventory's vocabulary. Since the accounting rewrite they are
 * resolved to a `gl_system_tag` (below) and the kernel resolves the tag to an
 * account in the organisation's default book, so nothing in inventory names an
 * account id or an account code, and a tenant that renumbers its chart keeps
 * posting to the same roles.
 *
 * `AR` and `SALES_INCOME` are listed because the sales-order invoice was once
 * posted through this list; the kernel-era invoice posts through
 * `PostingCommandService` directly with the same two roles.
 */
export const INVENTORY_JOURNAL_PURPOSES = [
  "INVENTORY_ASSET",
  "INVENTORY_COGS",
  "INVENTORY_GRNI",
  "AP",
  "AR",
  "SALES_INCOME",
] as const;

export type InventoryJournalPurpose = (typeof INVENTORY_JOURNAL_PURPOSES)[number];

/**
 * The account role each purpose posts to.
 *
 * The one row that is an accounting decision rather than a translation is
 * `INVENTORY_GRNI`. TODO(ACC-03): a goods receipt should credit `grni`, and the
 * purchase bill should move it to `ap_control` (`docs/inventory-gl-contract.md`
 * §2.2, migration 0672). It credits `ap_control` here because the one-shot
 * receive in `grn-receive.service.ts` credits `ap_control`, and both receipt
 * paths post under the same key `stock_move:{grnId}:receive`. Two paths that
 * booked one event to two different accounts would be worse than either
 * answer. Change both together, and only once the bill drains GRNI; until then
 * vendor returns debit `grni`, so that account can run negative.
 */
export const INVENTORY_PURPOSE_TAG: Readonly<Record<InventoryJournalPurpose, GlSystemTag>> = {
  INVENTORY_ASSET: "inventory",
  INVENTORY_COGS: "cogs",
  INVENTORY_GRNI: "ap_control",
  AP: "ap_control",
  AR: "ar_control",
  SALES_INCOME: "sales",
};

/**
 * The code of the account filling each purpose's role in the organisation's
 * default book. `null` when the organisation keeps no book, or when no active
 * account carries the role. A null is exactly the case in which a post would
 * be refused with `UNKNOWN_ACCOUNT_TAG`.
 */
export type InventoryAccountCodes = Record<InventoryJournalPurpose, string | null>;

/**
 * Which stock document a journal values, and the posting purpose it is keyed
 * under. The kernel's idempotency key is `stock_move:{sourceId}:{sourceEvent}`.
 *
 * A closed set, for the reason `StockDocumentKind` is one: ids come from
 * different tables, so the purpose is what keeps two documents out of one key.
 *
 *   - `receive` is shared on purpose with `grn-receive.service.ts`. Both are
 *     "this GRN was posted", so one GRN can only ever produce one receipt
 *     journal, whichever path posted it.
 *   - `landed_cost` has no kernel document kind at all. See
 *     `landed-cost/lib/landed-cost-journal.ts` for the open decision.
 */
export type InventoryJournalSource =
  | { sourceType: "inv_grn"; sourceEvent: "receive" }
  | { sourceType: "inv_landed_cost"; sourceEvent: "landed_cost" };

/**
 * One line, named by purpose. Amounts are exact decimal strings in the book's
 * major unit, the representation inventory computes in. They become whole minor
 * units only inside `postJournalEntry`, and only through `toMinorUnits`. A line
 * is a debit or a credit, never both.
 */
export interface InventoryJournalLine {
  purpose: InventoryJournalPurpose;
  debit?: string;
  credit?: string;
  description?: string;
}

export type InventoryJournalDraft = InventoryJournalSource & {
  orgId: string;
  /** Who caused the post. `null` for an unattended one. */
  createdBy: string | null;
  entryDate: string;
  description: string;
  sourceId: string;
  lines: InventoryJournalLine[];
};

/**
 * A decimal amount as whole minor units: hundredths, rounded half away from zero.
 *
 * Exact. It uses `BigInt` on the digits and never multiplies a float by 100,
 * because at a tie that multiplication is where a figure changes and nothing
 * reports it (`1.005 * 100` is `100.49999…`). Two decimals is the convention
 * every kernel-era inventory post uses: `StockMovementBridgeService`,
 * `grn-receive`'s receipt and `so-fulfillment`'s COGS all multiply by 100.
 * Matching them keeps one receipt from being valued differently by its two
 * paths and keeps the kernel's reconciliation from reporting its own rounding.
 *
 * Negative amounts are refused. A line carries a magnitude, and its direction is
 * whether it is a debit or a credit.
 */
export function toMinorUnits(amount: string): number {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match) {
    throw new UnprocessableEntityException(
      `${JSON.stringify(amount)} is not an amount the general ledger can take`,
    );
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  const hundredths = BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  const rounded = Number(fraction.charAt(2) || "0") >= 5 ? hundredths + 1n : hundredths;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnprocessableEntityException(
      `${amount} is beyond what the general ledger can hold in minor units`,
    );
  }
  return assertSafeMinor(Number(rounded));
}

/** The inverse of `toMinorUnits`, in integer arithmetic: 1234 → "12.34". */
export function minorUnitsToDecimal(minor: number): string {
  const safe = assertSafeMinor(minor);
  const sign = safe < 0 ? "-" : "";
  const abs = Math.abs(safe);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
