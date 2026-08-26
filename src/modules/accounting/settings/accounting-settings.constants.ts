import type { SystemAccountPurpose } from "./dto/settings.schemas";

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
