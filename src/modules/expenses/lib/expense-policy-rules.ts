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
 * The decimal arithmetic is the expenses family's `decimal(x,2)` MAJOR-unit
 * convention, compared through `compareDecimals` rather than through JS number
 * comparison. It moved from the service character for character.
 */
import { and, eq } from "drizzle-orm";
import { createHash } from "crypto";
import { expenses, finExpensePolicies, finApprovalPolicies } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { compareDecimals, formatDecimal } from "../../accounting/core/money.util";

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
  approverUserId: string | null;
  policyId: number | null;
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
  const raw = `${orgId}|${formatDecimal(amount, 2)}|${expenseDate}|${normalizeMerchant(merchant)}`;
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
  amount: number,
  hasReceipt: boolean,
): Promise<PolicyEvalResult> {
  const conditions = [
    eq(finExpensePolicies.orgId, orgId),
    eq(finExpensePolicies.isActive, true),
  ];

  const policies = await deps.db
    .select()
    .from(finExpensePolicies)
    .where(and(...conditions));

  const applicable = policies.filter(
    (p) => p.categoryId === null || p.categoryId === categoryId,
  );

  let policyFlag: string | null = null;

  for (const policy of applicable) {
    if (policy.maxAmount !== null && compareDecimals(amount.toString(), policy.maxAmount) > 0) {
      return { policyFlag: "OVER_LIMIT", blocked: true, blockReason: `Amount exceeds policy limit of ${policy.maxAmount}` };
    }

    if (
      policy.requiresReceiptAbove !== null &&
      compareDecimals(amount.toString(), policy.requiresReceiptAbove) > 0 &&
      !hasReceipt
    ) {
      policyFlag = "RECEIPT_REQUIRED";
    }
  }

  return { policyFlag, blocked: false, blockReason: null };
}

export async function findApplicableApprovalPolicy(
  deps: ExpensePolicyDeps,
  orgId: string,
  amount: number,
): Promise<ApprovalCheckResult> {
  const policies = await deps.db
    .select()
    .from(finApprovalPolicies)
    .where(
      and(
        eq(finApprovalPolicies.orgId, orgId),
        eq(finApprovalPolicies.recordType, "EXPENSE"),
        eq(finApprovalPolicies.isActive, true),
      ),
    );

  const applicable = policies.find((p) => {
    if (p.minAmount === null) return true;
    return compareDecimals(amount.toString(), p.minAmount) >= 0;
  });

  if (!applicable) {
    return { needsApproval: false, approverUserId: null, policyId: null };
  }

  return {
    needsApproval: true,
    approverUserId: applicable.approverUserId ?? null,
    policyId: applicable.id,
  };
}
