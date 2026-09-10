import type { SystemAccountPurpose } from "./dto/settings.schemas";

export const SETTINGS_CACHE_KEY = (orgId: string) => `acc:settings:${orgId}`;
export const COA_TREE_CACHE_KEY = (orgId: string) => `acc:coa:tree:${orgId}`;
export const SETUP_STATUS_CACHE_KEY = (orgId: string) => `acc:setup-status:${orgId}`;
export const ACCT_STATEMENTS_NS = (orgId: string) => `acc:statements:${orgId}`;

export const PURPOSE_ALLOWED_TYPES: Record<SystemAccountPurpose, string[]> = {
  AR: ["ASSET"],
  AP: ["LIABILITY"],
  BANK_CLEARING: ["ASSET"],
  SALES_INCOME: ["INCOME"],
  DISCOUNT_GIVEN: ["EXPENSE"],
  TAX_PAYABLE: ["LIABILITY"],
  TAX_RECEIVABLE: ["ASSET"],
  PAYROLL_PAYABLE: ["LIABILITY"],
  EXPENSE_CLEARING: ["EXPENSE", "ASSET"],
  RETAINED_EARNINGS: ["EQUITY"],
  OWNER_EQUITY: ["EQUITY"],
  PAYMENT_FEES: ["EXPENSE"],
  REIMBURSEMENT_PAYABLE: ["LIABILITY"],
  FX_GAIN_LOSS: ["INCOME", "EXPENSE"],
  DEPRECIATION_EXPENSE: ["EXPENSE"],
  ACCUM_DEPRECIATION: ["ASSET"],
  SALARY_EXPENSE: ["EXPENSE"],
  ASSET_DISPOSAL_GAIN_LOSS: ["INCOME", "EXPENSE"],
  // INV-09. GRNI and landed-cost clearing are liabilities: both sit on the
  // credit side of a receipt, and both are what the tenant owes for goods or
  // freight it has taken delivery of but not yet been billed for.
  INVENTORY_ASSET: ["ASSET"],
  INVENTORY_COGS: ["EXPENSE"],
  INVENTORY_GRNI: ["LIABILITY"],
  INVENTORY_LANDED_COST_CLEARING: ["LIABILITY"],
  INVENTORY_WRITE_OFF: ["EXPENSE"],
  // Either side, like FX_GAIN_LOSS and ASSET_DISPOSAL_GAIN_LOSS above: a count
  // variance is a gain as often as a loss, and which one it is is not a
  // property of the mapping.
  INVENTORY_ADJUSTMENT_GAIN_LOSS: ["INCOME", "EXPENSE"],
};

export const PURPOSE_SUGGESTED_CODE: Record<SystemAccountPurpose, string> = {
  AR: "1200",
  AP: "2000",
  BANK_CLEARING: "1100",
  SALES_INCOME: "4000",
  DISCOUNT_GIVEN: "5990",
  TAX_PAYABLE: "2100",
  TAX_RECEIVABLE: "1410",
  PAYROLL_PAYABLE: "2300",
  EXPENSE_CLEARING: "5990",
  RETAINED_EARNINGS: "3100",
  OWNER_EQUITY: "3000",
  PAYMENT_FEES: "5910",
  REIMBURSEMENT_PAYABLE: "2400",
  FX_GAIN_LOSS: "4900",
  DEPRECIATION_EXPENSE: "5900",
  ACCUM_DEPRECIATION: "1590",
  SALARY_EXPENSE: "5100",
  ASSET_DISPOSAL_GAIN_LOSS: "4900",
  // Every one of these is a code that already exists in `DEFAULT_COA`, and the
  // first four are the codes inventory's journal builders already name as
  // literals. None is invented: a suggestion pointing at an account the tenant
  // does not have is just a blank suggestion, and a *default* pointing at one
  // would fail the posting it was supposed to rescue.
  INVENTORY_ASSET: "1300",
  INVENTORY_COGS: "5000",
  // 2000 rather than a dedicated GRNI account, because 2000 is what
  // `receipt-journal.ts` credits on a goods receipt today. The mapping makes
  // that visible and separable; it does not silently move it.
  INVENTORY_GRNI: "2000",
  // Likewise 2000 — see `PAYABLE_ACCOUNT` in `landed-cost-apply.service.ts` for
  // why landed cost credits the payable and not a clearing account today.
  INVENTORY_LANDED_COST_CLEARING: "2000",
  INVENTORY_WRITE_OFF: "5990",
  INVENTORY_ADJUSTMENT_GAIN_LOSS: "4900",
};

export const SEQUENCE_DEFAULTS: Record<string, { prefix: string; padding: number }> = {
  journal: { prefix: "JE", padding: 6 },
  invoice: { prefix: "INV", padding: 5 },
  credit_note: { prefix: "CN", padding: 5 },
  bill: { prefix: "BILL", padding: 5 },
  vendor_credit: { prefix: "VC", padding: 5 },
  payment: { prefix: "PAY", padding: 5 },
  asset: { prefix: "AST", padding: 5 },
};
