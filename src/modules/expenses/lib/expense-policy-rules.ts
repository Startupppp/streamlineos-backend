/**
 * The rules an expense is measured against before it is allowed to move.
 *
 * Every function here is a pure read: it answers a question about policy tables
 * and the existing expense rows and returns a verdict. None of them writes, and
 * none of them audits, posts, emits or invalidates a cache — which is exactly
 * what separates them from the three transition methods that call them. A
 * failure in here is "this expense is not allowed"; a failure over there is
 * "this expense half-moved".
 *
 * Expense rows carry the expenses family's `decimal(x,2)` MAJOR-unit strings.
 * Every comparison converts both sides to integer minor units first
 * (`amountToMinor`), so no two amounts are ever compared as floats — the job
 * `compareDecimals` did until the accounting rewrite retired
 * `accounting/core/money.util`.
 */
import { and, eq } from "drizzle-orm";
import { createHash } from "crypto";
import { expenses, finExpensePolicies } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { fromDecimalString, money, toDecimalString } from "../../accounting/kernel/money";

export interface ExpensePolicyDeps {
  readonly db: Db;
}

export interface PolicyEvalResult {
  policyFlag: string | null;
  blocked: boolean;
  blockReason: string | null;
}

export interface ApprovalCheckResult {
  needsApproval: boolean;
  policyId: number | null;
}

/**
 * Expense rows carry decimal strings; the ledger kernel works in integer minor
 * units. Everything crossing into accounting — and every policy comparison —
 * converts here, once, so no two amounts are ever compared as floats.
 *
 * `expenses.currency` is free text that predates the currency catalogue, so an
 * unrecognised code falls back to a two-decimal reading rather than throwing:
 * refusing to submit an expense over a currency code is a worse answer than
 * assuming the near-universal scale.
 */
export function amountToMinor(amount: string | number, currency: string): number {
  const text = typeof amount === "number" ? amount.toString() : amount.trim();
  try {
    return fromDecimalString(text, currency.toUpperCase()).minor;
  } catch {
    return fromDecimalString(Number(text).toFixed(2), "INR").minor;
  }
}

function normalizeMerchant(merchant: string | null | undefined): string {
  if (!merchant) return "";
  return merchant.trim().toLowerCase().replace(/\s+/g, " ");
}

export function buildReceiptHash(
  orgId: string,
  amount: string,
  expenseDate: string,
  merchant: string | null | undefined,
): string {
  // Two decimals, exactly as the retired `formatDecimal(amount, 2)` produced,
  // so hashes computed before the rewrite still match.
  const normalizedAmount = toDecimalString(money(amountToMinor(amount, "INR"), "INR"));
  const raw = `${orgId}|${normalizedAmount}|${expenseDate}|${normalizeMerchant(merchant)}`;
  return createHash("sha256").update(raw).digest("hex");
}

export async function checkDuplicate(
  deps: ExpensePolicyDeps,
  orgId: string,
  hash: string,
  excludeExpenseId?: number,
): Promise<number | null> {
  const rows = await deps.db
    .select({ id: expenses.id })
    .from(expenses)
    .where(and(eq(expenses.orgId, orgId), eq(expenses.receiptHash, hash)))
    .limit(2);

  for (const row of rows) {
    if (excludeExpenseId === undefined || row.id !== excludeExpenseId) {
      return row.id;
    }
  }
  return null;
}

export async function evaluatePolicy(
  deps: ExpensePolicyDeps,
  orgId: string,
  categoryId: number | null | undefined,
  amount: number | string,
  currency: string,
  hasReceipt: boolean,
): Promise<PolicyEvalResult> {
  const policies = await deps.db
    .select()
    .from(finExpensePolicies)
    .where(
      and(
        eq(finExpensePolicies.orgId, orgId),
        eq(finExpensePolicies.isActive, true),
      ),
    );

  const applicable = policies.filter(
    (p) => p.categoryId === null || p.categoryId === categoryId,
  );

  const amountMinor = amountToMinor(amount, currency);
  let policyFlag: string | null = null;

  for (const policy of applicable) {
    if (
      policy.maxAmount !== null &&
      amountMinor > amountToMinor(policy.maxAmount, currency)
    ) {
      return {
        policyFlag: "OVER_LIMIT",
        blocked: true,
        blockReason: `Amount exceeds policy limit of ${policy.maxAmount}`,
      };
    }

    if (
      policy.requiresReceiptAbove !== null &&
      amountMinor > amountToMinor(policy.requiresReceiptAbove, currency) &&
      !hasReceipt
    ) {
      policyFlag = "RECEIPT_REQUIRED";
    }
  }

  return { policyFlag, blocked: false, blockReason: null };
}

/**
 * Whether this claim needs a second pair of eyes.
 *
 * The retired `fin_approval_policies` / `fin_approval_requests` pair went with
 * the pre-rewrite accounting schema and has no successor — there is no
 * org-wide approval table on the new kernel. The threshold now comes from
 * `fin_expense_policies.requires_approval_above`, which is the column that was
 * always meant to carry it, and the pending state is the expense's own
 * `SUBMITTED` status rather than a parallel request row.
 */
export async function findApplicableApprovalPolicy(
  deps: ExpensePolicyDeps,
  orgId: string,
  categoryId: number | null | undefined,
  amount: number | string,
  currency: string,
): Promise<ApprovalCheckResult> {
  const policies = await deps.db
    .select()
    .from(finExpensePolicies)
    .where(
      and(
        eq(finExpensePolicies.orgId, orgId),
        eq(finExpensePolicies.isActive, true),
      ),
    );

  const amountMinor = amountToMinor(amount, currency);
  const triggered = policies
    .filter((p) => p.categoryId === null || p.categoryId === categoryId)
    .find(
      (p) =>
        p.requiresApprovalAbove !== null &&
        amountMinor > amountToMinor(p.requiresApprovalAbove, currency),
    );

  return triggered
    ? { needsApproval: true, policyId: triggered.id }
    : { needsApproval: false, policyId: null };
}
