import type { GlAccountType, GlSystemTag } from "../../../db/schema";

/**
 * Which account types may fill each system role.
 *
 * A role is how a document names an account without knowing the tenant's chart
 * — `cogs`, `inventory`, `ap_control`. Nothing stopped an operator putting
 * `cogs` on an equity account, and no posting would ever complain: the journal
 * still balances, and it is the *classification* that is wrong, so the error
 * shows up as a P&L that is quietly missing its cost of sales.
 *
 * Deliberately enforced at the moment a tag is **assigned**, never at the
 * moment a journal is posted. A tenant whose chart predates this map keeps
 * posting exactly as before; the validation only asks that the next person to
 * move a role puts it somewhere the role can live. Validating at post time
 * would turn a historical mapping choice into an outage.
 *
 * Exhaustive by construction: `Record<GlSystemTag, …>` means a new member of
 * `gl_system_tag` does not compile until someone has decided what kind of
 * account it is.
 */
export const SYSTEM_TAG_ACCOUNT_TYPES: Record<GlSystemTag, readonly GlAccountType[]> = {
  cash: ["ASSET"],
  bank: ["ASSET"],
  undeposited: ["ASSET"],
  ar_control: ["ASSET"],
  ap_control: ["LIABILITY"],
  grni: ["LIABILITY"],
  sales: ["INCOME"],
  other_income: ["INCOME"],
  cogs: ["EXPENSE"],
  opex: ["EXPENSE"],
  salary: ["EXPENSE"],
  equity_capital: ["EQUITY"],
  retained_earnings: ["EQUITY"],
  current_year_earnings: ["EQUITY"],
  fx_gain: ["INCOME"],
  fx_loss: ["EXPENSE"],
  /* Rounding lands on whichever side the pack's tolerance falls; both are real charts. */
  rounding: ["INCOME", "EXPENSE"],

  vat_input: ["ASSET"],
  vat_output: ["LIABILITY"],
  sales_tax_payable: ["LIABILITY"],
  wht_payable: ["LIABILITY"],

  gst_input_cgst: ["ASSET"],
  gst_input_sgst: ["ASSET"],
  gst_input_igst: ["ASSET"],
  gst_input_utgst: ["ASSET"],
  gst_input_cess: ["ASSET"],
  gst_output_cgst: ["LIABILITY"],
  gst_output_sgst: ["LIABILITY"],
  gst_output_igst: ["LIABILITY"],
  gst_output_utgst: ["LIABILITY"],
  gst_output_cess: ["LIABILITY"],

  /* Money the processor holds and owes us — a receivable, never a bank. */
  psp_clearing: ["ASSET"],
  razorpay_clearing: ["ASSET"],
  stripe_clearing: ["ASSET"],
  payment_fees: ["EXPENSE"],

  net_pay_clearing: ["LIABILITY"],
  statutory_payable: ["LIABILITY"],

  fixed_asset: ["ASSET"],
  accum_depreciation: ["CONTRA_ASSET"],
  depreciation_expense: ["EXPENSE"],
  deferred_revenue: ["LIABILITY"],

  inventory: ["ASSET"],
  inventory_write_off: ["EXPENSE"],
  /*
    Expense only, even though a count gain credits it. That is the point of one
    account rather than a gain/loss pair: the balance IS the period's net
    adjustment cost. A credit balance on an expense account is unremarkable and
    reads correctly on the P&L; splitting it in two would make the net
    recoverable only by a report that added them back.
  */
  inventory_adjustment: ["EXPENSE"],
};

/**
 * The roles the inventory bridge resolves **today**, from the three call sites
 * `docs/inventory-gl-contract.md` §2 enumerates. A book missing one of these
 * has a real, dated problem: its next goods receipt or shipment is refused
 * outright with `UNKNOWN_ACCOUNT_TAG`.
 */
export const INVENTORY_SEAM_ROLES = [
  "inventory",
  "cogs",
  "ap_control",
  "ar_control",
  "sales",
] as const satisfies readonly GlSystemTag[];

/**
 * Roles the chart now seeds and **no call site resolves yet**.
 *
 * Kept separate rather than folded into the list above, because the difference
 * is the difference between a warning that means something and one that cries
 * wolf. A book without `grni` is not currently broken — the goods receipt
 * credits `ap_control` instead, which is wrong (0672) but works. Reporting it
 * as missing alongside a genuinely missing `inventory` account would teach an
 * operator to ignore both.
 *
 * Each one moves into `INVENTORY_SEAM_ROLES` in the same commit as the call
 * site that starts resolving it, never before.
 */
export const INVENTORY_SEAM_ROLES_PENDING = [
  "grni",
  "inventory_write_off",
  "inventory_adjustment",
] as const satisfies readonly GlSystemTag[];

/** Every role, in chart order, for the mapping screen. */
export const ALL_SYSTEM_TAGS = Object.keys(SYSTEM_TAG_ACCOUNT_TYPES) as GlSystemTag[];

export function accountTypeFitsRole(tag: GlSystemTag, accountType: string): boolean {
  return (SYSTEM_TAG_ACCOUNT_TYPES[tag] as readonly string[]).includes(accountType);
}
