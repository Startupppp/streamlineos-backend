import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  finBankTransactions,
  finBankAccounts,
  finReconciliationMatches,
  finReconciliationRules,
  journalEntries,
  journalLines,
  payments,
  invoices,
  vendorPayments,
  clients,
} from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

interface MatchCandidate {
  type: "CUSTOMER_PAYMENT" | "VENDOR_PAYMENT" | "MANUAL_JOURNAL";
  recordId: number;
  journalEntryId: number | null;
  amount: string;
  date: string;
  reference: string | null;
  counterpartyName: string | null;
}

interface RuleCondition {
  field: "description" | "counterparty" | "amount";
  op: "contains" | "equals" | "gt" | "lt";
  value: string;
}

interface RuleAction {
  type: "categorize" | "transfer" | "fee";
  accountPurposeOrId?: string | number;
  memo?: string;
}

const ruleConditionSchema = z.object({
  field: z.enum(["description", "counterparty", "amount"]),
  op: z.enum(["contains", "equals", "gt", "lt"]),
  value: z.string(),
});

const ruleActionSchema = z.object({
  type: z.enum(["categorize", "transfer", "fee"]),
  accountPurposeOrId: z.union([z.string(), z.number()]).optional(),
  memo: z.string().optional(),
});

function normalizeName(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

function scoreDateProximity(txnDate: string, candidateDate: string): number {
  const a = new Date(txnDate).getTime();
  const b = new Date(candidateDate).getTime();
  const diffDays = Math.abs((a - b) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 20;
  if (diffDays <= 1) return 16;
  if (diffDays <= 3) return 10;
  return 0;
}

function scoreReference(txnRef: string | null | undefined, candidateRef: string | null | undefined): number {
  if (!txnRef || !candidateRef) return 0;
  const a = txnRef.toLowerCase().trim();
  const b = candidateRef.toLowerCase().trim();
  if (a === b) return 20;
  if (a.includes(b) || b.includes(a)) return 20;
  return 0;
}

function scoreCounterparty(txnCounterparty: string | null | undefined, candidateName: string | null | undefined): number {
  if (!txnCounterparty || !candidateName) return 0;
  const a = normalizeName(txnCounterparty);
  const b = normalizeName(candidateName);
  if (a.includes(b) || b.includes(a)) return 10;
  return 0;
}

function evaluateRule(txn: { description: string | null; counterparty: string | null; amount: string }, condition: RuleCondition): boolean {
  let fieldValue: string;
  if (condition.field === "description") {
    fieldValue = (txn.description ?? "").toLowerCase();
  } else if (condition.field === "counterparty") {
    fieldValue = (txn.counterparty ?? "").toLowerCase();
  } else {
    fieldValue = txn.amount;
  }

  const condVal = condition.value.toLowerCase();
  const numVal = parseFloat(condition.value);
  const txnNum = parseFloat(txn.amount);

  switch (condition.op) {
    case "contains": return fieldValue.includes(condVal);
    case "equals": return fieldValue === condVal;
    case "gt": return Number.isFinite(numVal) && txnNum > numVal;
    case "lt": return Number.isFinite(numVal) && txnNum < numVal;
    default: return false;
  }
}

@Injectable()
export class MatchingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  async suggestMatches(u: CurrentUserContext, bankAccountId: number, transactionIds?: number[]): Promise<void> {
    const { orgId } = u;

    const account = await this.db.query.finBankAccounts.findFirst({
      where: and(eq(finBankAccounts.id, bankAccountId), eq(finBankAccounts.orgId, orgId)),
      columns: { id: true, ledgerAccountId: true },
    });
    if (!account) return;

    const activeRules = await this.db
      .select()
      .from(finReconciliationRules)
      .where(and(eq(finReconciliationRules.orgId, orgId), eq(finReconciliationRules.isActive, true)))
      .orderBy(sql`${finReconciliationRules.priority} DESC`);

    const txnWhere = and(
      eq(finBankTransactions.orgId, orgId),
      eq(finBankTransactions.bankAccountId, bankAccountId),
      eq(finBankTransactions.status, "UNMATCHED"),
      ...(transactionIds && transactionIds.length > 0
        ? [inArray(finBankTransactions.id, transactionIds)]
        : []),
    );

    const txns = await this.db
      .select()
      .from(finBankTransactions)
      .where(txnWhere);

    if (txns.length === 0) return;

    const [firstTxn] = txns;
    if (!firstTxn) return;

    const dateMin = txns.reduce((min, t) => (t.txnDate < min ? t.txnDate : min), firstTxn.txnDate);
    const dateMax = txns.reduce((max, t) => (t.txnDate > max ? t.txnDate : max), firstTxn.txnDate);

    const windowMin = new Date(dateMin);
    windowMin.setDate(windowMin.getDate() - 3);
    const windowMax = new Date(dateMax);
    windowMax.setDate(windowMax.getDate() + 3);
    const windowMinStr = windowMin.toISOString().slice(0, 10);
    const windowMaxStr = windowMax.toISOString().slice(0, 10);

    const [customerPayments, vendorPaymentRows, journalRows, clientRows] = await Promise.all([
      this.db
        .select({
          id: payments.id,
          amount: payments.amount,
          paymentDate: payments.paymentDate,
          referenceNumber: payments.referenceNumber,
          clientId: invoices.clientId,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(
          and(
            eq(payments.orgId, orgId),
            gte(payments.paymentDate, windowMinStr),
            lte(payments.paymentDate, windowMaxStr),
          ),
        ),
      this.db
        .select({
          id: vendorPayments.id,
          amount: vendorPayments.amount,
          paymentDate: vendorPayments.paymentDate,
          referenceNumber: vendorPayments.referenceNumber,
          billId: vendorPayments.billId,
        })
        .from(vendorPayments)
        .where(
          and(
            eq(vendorPayments.orgId, orgId),
            gte(vendorPayments.paymentDate, windowMinStr),
            lte(vendorPayments.paymentDate, windowMaxStr),
          ),
        ),
      account.ledgerAccountId
        ? this.db
            .select({
              id: journalEntries.id,
              entryDate: journalEntries.entryDate,
              description: journalEntries.description,
              amount: sql<string>`SUM(CAST(${journalLines.debit} AS numeric))`,
            })
            .from(journalEntries)
            .innerJoin(journalLines, and(
              eq(journalLines.entryId, journalEntries.id),
              eq(journalLines.accountId, account.ledgerAccountId),
            ))
            .where(
              and(
                eq(journalEntries.orgId, orgId),
                gte(journalEntries.entryDate, windowMinStr),
                lte(journalEntries.entryDate, windowMaxStr),
                eq(journalEntries.status, "POSTED"),
              ),
            )
            .groupBy(journalEntries.id, journalEntries.entryDate, journalEntries.description)
        : Promise.resolve([]),
      this.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(eq(clients.orgId, orgId)),
    ]);

    const clientMap = new Map(clientRows.map((c) => [c.id, c.name]));

    for (const txn of txns) {
      const txnAmount = parseFloat(txn.amount);
      const absAmount = Math.abs(txnAmount);

      let ruleMatched = false;
      for (const rule of activeRules) {
        const conditionsResult = z.array(ruleConditionSchema).safeParse(rule.conditions);
        const actionResult = ruleActionSchema.safeParse(rule.action);
        if (!conditionsResult.success || !actionResult.success) continue;
        const conditions: RuleCondition[] = conditionsResult.data;
        const action: RuleAction = actionResult.data;
        const allMatch = conditions.every((c) => evaluateRule(txn, c));
        if (!allMatch) continue;

        ruleMatched = true;
        const existing = await this.db.query.finReconciliationMatches.findFirst({
          where: and(
            eq(finReconciliationMatches.orgId, orgId),
            eq(finReconciliationMatches.bankTransactionId, txn.id),
          ),
          columns: { id: true },
        });
        if (existing) break;

        const matchType = action.type === "fee" ? "BANK_FEE" : action.type === "transfer" ? "TRANSFER" : "MANUAL_JOURNAL";

        await this.db.insert(finReconciliationMatches).values({
          orgId,
          bankTransactionId: txn.id,
          journalEntryId: null,
          matchedType: matchType,
          matchedRecordId: null,
          amount: txn.amount,
          confidence: "90.00",
          isConfirmed: false,
        });

        await this.db
          .update(finBankTransactions)
          .set({ status: "SUGGESTED" })
          .where(and(eq(finBankTransactions.id, txn.id), eq(finBankTransactions.orgId, orgId)));

        break;
      }

      if (ruleMatched) continue;

      const candidates: Array<{ candidate: MatchCandidate; score: number }> = [];

      for (const cp of customerPayments) {
        const cpAmount = parseFloat(cp.amount);
        if (Math.abs(cpAmount - absAmount) > 0.01) continue;
        let score = 50;
        score += scoreDateProximity(txn.txnDate, cp.paymentDate);
        score += scoreReference(txn.reference, cp.referenceNumber);
        const clientName = cp.clientId !== null ? (clientMap.get(cp.clientId) ?? null) : null;
        score += scoreCounterparty(txn.counterparty, clientName);
        candidates.push({
          candidate: {
            type: "CUSTOMER_PAYMENT",
            recordId: cp.id,
            journalEntryId: null,
            amount: cp.amount,
            date: cp.paymentDate,
            reference: cp.referenceNumber ?? null,
            counterpartyName: clientName,
          },
          score,
        });
      }

      for (const vp of vendorPaymentRows) {
        const vpAmount = parseFloat(vp.amount);
        if (Math.abs(vpAmount - absAmount) > 0.01) continue;
        let score = 50;
        score += scoreDateProximity(txn.txnDate, vp.paymentDate);
        score += scoreReference(txn.reference, vp.referenceNumber);
        candidates.push({
          candidate: {
            type: "VENDOR_PAYMENT",
            recordId: vp.id,
            journalEntryId: null,
            amount: vp.amount,
            date: vp.paymentDate,
            reference: vp.referenceNumber ?? null,
            counterpartyName: null,
          },
          score,
        });
      }

      for (const je of journalRows) {
        const jeAmount = parseFloat(String(je.amount ?? "0"));
        if (Math.abs(jeAmount - absAmount) > 0.01) continue;
        let score = 50;
        score += scoreDateProximity(txn.txnDate, je.entryDate);
        score += scoreReference(txn.reference, null);
        score += scoreCounterparty(txn.counterparty, je.description);
        candidates.push({
          candidate: {
            type: "MANUAL_JOURNAL",
            recordId: je.id,
            journalEntryId: je.id,
            amount: String(je.amount ?? "0"),
            date: je.entryDate,
            reference: null,
            counterpartyName: null,
          },
          score,
        });
      }

      const best = candidates.sort((a, b) => b.score - a.score)[0];
      if (!best || best.score < 60) continue;

      const existing = await this.db.query.finReconciliationMatches.findFirst({
        where: and(
          eq(finReconciliationMatches.orgId, orgId),
          eq(finReconciliationMatches.bankTransactionId, txn.id),
        ),
        columns: { id: true },
      });
      if (existing) continue;

      await this.db.insert(finReconciliationMatches).values({
        orgId,
        bankTransactionId: txn.id,
        journalEntryId: best.candidate.journalEntryId ?? null,
        matchedType: best.candidate.type,
        matchedRecordId: best.candidate.recordId,
        amount: txn.amount,
        confidence: String(Math.min(best.score, 100).toFixed(2)),
        isConfirmed: false,
      });

      await this.db
        .update(finBankTransactions)
        .set({ status: "SUGGESTED" })
        .where(and(eq(finBankTransactions.id, txn.id), eq(finBankTransactions.orgId, orgId)));
    }
  }
}
