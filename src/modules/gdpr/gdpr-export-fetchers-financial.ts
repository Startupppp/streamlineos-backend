import { and, asc, eq, gt } from "drizzle-orm";
import {
  bonuses,
  expenses,
  fnfSettlements,
  reimbursements,
  salaryLoans,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { BATCH_SIZE } from "./gdpr-export-types";

export async function fetchExpenses(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [eq(expenses.orgId, orgId), eq(expenses.userId, userId)];
  if (afterId !== undefined) conditions.push(gt(expenses.id, afterId));
  return db
    .select({
      id: expenses.id,
      category: expenses.category,
      amount: expenses.amount,
      currency: expenses.currency,
      description: expenses.description,
      receiptFileName: expenses.receiptFileName,
      merchant: expenses.merchant,
      receiptNumber: expenses.receiptNumber,
      taxAmount: expenses.taxAmount,
      paymentMethod: expenses.paymentMethod,
      status: expenses.status,
      approvedAt: expenses.approvedAt,
      rejectionReason: expenses.rejectionReason,
      paidAt: expenses.paidAt,
      transactionRef: expenses.transactionRef,
      policyFlag: expenses.policyFlag,
      expenseDate: expenses.expenseDate,
      createdAt: expenses.createdAt,
      updatedAt: expenses.updatedAt,
    })
    .from(expenses)
    .where(and(...conditions))
    .orderBy(asc(expenses.id))
    .limit(BATCH_SIZE);
}

export async function fetchReimbursements(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(reimbursements.orgId, orgId),
    eq(reimbursements.userId, userId),
  ];
  if (afterId !== undefined) conditions.push(gt(reimbursements.id, afterId));
  return db
    .select({
      id: reimbursements.id,
      category: reimbursements.category,
      amount: reimbursements.amount,
      description: reimbursements.description,
      status: reimbursements.status,
      payrollMonth: reimbursements.payrollMonth,
      approvedAt: reimbursements.approvedAt,
      paidAt: reimbursements.paidAt,
      rejectionReason: reimbursements.rejectionReason,
      createdAt: reimbursements.createdAt,
      updatedAt: reimbursements.updatedAt,
    })
    .from(reimbursements)
    .where(and(...conditions))
    .orderBy(asc(reimbursements.id))
    .limit(BATCH_SIZE);
}

export async function fetchSalaryLoans(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(salaryLoans.orgId, orgId),
    eq(salaryLoans.userId, userId),
  ];
  if (afterId !== undefined) conditions.push(gt(salaryLoans.id, afterId));
  return db
    .select({
      id: salaryLoans.id,
      amount: salaryLoans.amount,
      reason: salaryLoans.reason,
      emiAmount: salaryLoans.emiAmount,
      totalEmis: salaryLoans.totalEmis,
      paidEmis: salaryLoans.paidEmis,
      status: salaryLoans.status,
      approvedAt: salaryLoans.approvedAt,
      disbursedAt: salaryLoans.disbursedAt,
      closedAt: salaryLoans.closedAt,
      createdAt: salaryLoans.createdAt,
      updatedAt: salaryLoans.updatedAt,
    })
    .from(salaryLoans)
    .where(and(...conditions))
    .orderBy(asc(salaryLoans.id))
    .limit(BATCH_SIZE);
}

export async function fetchBonuses(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [eq(bonuses.orgId, orgId), eq(bonuses.userId, userId)];
  if (afterId !== undefined) conditions.push(gt(bonuses.id, afterId));
  return db
    .select({
      id: bonuses.id,
      type: bonuses.type,
      amount: bonuses.amount,
      amountCents: bonuses.amountCents,
      reason: bonuses.reason,
      month: bonuses.month,
      taxable: bonuses.taxable,
      status: bonuses.status,
      approvedAt: bonuses.approvedAt,
      createdAt: bonuses.createdAt,
    })
    .from(bonuses)
    .where(and(...conditions))
    .orderBy(asc(bonuses.id))
    .limit(BATCH_SIZE);
}

export async function fetchFnfSettlements(
  db: Db,
  orgId: string,
  userId: string,
  afterId?: number,
) {
  const conditions = [
    eq(fnfSettlements.orgId, orgId),
    eq(fnfSettlements.userId, userId),
  ];
  if (afterId !== undefined) conditions.push(gt(fnfSettlements.id, afterId));
  return db
    .select({
      id: fnfSettlements.id,
      basicDues: fnfSettlements.basicDues,
      leaveEncashment: fnfSettlements.leaveEncashment,
      bonusDue: fnfSettlements.bonusDue,
      deductions: fnfSettlements.deductions,
      loanRecovery: fnfSettlements.loanRecovery,
      netPayable: fnfSettlements.netPayable,
      status: fnfSettlements.status,
      notes: fnfSettlements.notes,
      reimbursementsDue: fnfSettlements.reimbursementsDue,
      assetRecovery: fnfSettlements.assetRecovery,
      noticeRecovery: fnfSettlements.noticeRecovery,
      otherDeductions: fnfSettlements.otherDeductions,
      statementPublishedAt: fnfSettlements.statementPublishedAt,
      createdAt: fnfSettlements.createdAt,
      updatedAt: fnfSettlements.updatedAt,
    })
    .from(fnfSettlements)
    .where(and(...conditions))
    .orderBy(asc(fnfSettlements.id))
    .limit(BATCH_SIZE);
}
