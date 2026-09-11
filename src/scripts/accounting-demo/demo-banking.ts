/**
 * The bank side: a profile on the cash account, a statement built from what was
 * actually posted, every line matched, and the proof marked reconciled.
 *
 * The statement is derived rather than hardcoded, so the reconciliation holds by
 * construction instead of by a number someone kept in step by hand.
 */
import { and, eq, inArray } from "drizzle-orm";
import { bankMatches } from "../../db/schema";
import { money, toDecimalString } from "../../modules/accounting/kernel/money";
import {
  BOOKS_OPEN_ON,
  CODE,
  DAY_BEFORE_OPEN,
  QUARTER_END,
  accountIdFor,
  type Context,
} from "./demo-context";

const BANK_FILE_NAME = "demo-q1-2026-27.csv";
const PRESET = "IN_NARRATION_WITHDRAWAL_DEPOSIT";

export interface BankOutcome {
  reconciled: boolean;
  explanation: string;
}

interface StatementRow {
  valueDate: string;
  narration: string;
  reference: string;
  amountMinor: number;
  counterpart: { kind: "receipt" | "payment"; id: string };
}

function toDdMmYyyy(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** `Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.` — the India preset. */
function buildCsv(rows: readonly StatementRow[], currency: string): string {
  const header = "Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.";
  const body = rows.map((row) => {
    const amount = toDecimalString(money(Math.abs(row.amountMinor), currency));
    const [withdrawal, deposit] = row.amountMinor < 0 ? [amount, ""] : ["", amount];
    return [toDdMmYyyy(row.valueDate), row.narration, row.reference, withdrawal, deposit].join(",");
  });
  return [header, ...body].join("\n");
}

async function loadSettlements(
  ctx: Context,
  receiptIds: readonly string[],
  paymentId: string,
): Promise<StatementRow[]> {
  const rows: StatementRow[] = [];

  for (const receiptId of receiptIds) {
    const receipt = await ctx.receipts.get(ctx.orgId, receiptId);
    rows.push({
      valueDate: receipt.receiptDate,
      narration: `NEFT CR ${receipt.receiptNumber ?? receiptId.slice(0, 8)}`,
      reference: receipt.reference ?? receipt.receiptNumber ?? "",
      amountMinor: receipt.amountMinor,
      counterpart: { kind: "receipt", id: receiptId },
    });
  }

  const payment = await ctx.payments.get(ctx.orgId, paymentId);
  rows.push({
    valueDate: payment.paymentDate,
    narration: `NEFT DR ${payment.paymentNumber ?? paymentId.slice(0, 8)}`,
    reference: payment.reference ?? payment.paymentNumber ?? "",
    // Only the net leaves the bank; the withheld tax stays as a liability.
    amountMinor: -payment.netPaidMinor,
    counterpart: { kind: "payment", id: paymentId },
  });

  return rows.sort((a, b) => a.valueDate.localeCompare(b.valueDate));
}

async function matchedLineIds(ctx: Context, lineIds: readonly string[]): Promise<Set<string>> {
  if (lineIds.length === 0) return new Set();
  const rows = await ctx.db
    .select({ statementLineId: bankMatches.statementLineId })
    .from(bankMatches)
    .where(and(eq(bankMatches.orgId, ctx.orgId), inArray(bankMatches.statementLineId, [...lineIds])));
  return new Set(rows.map((r) => r.statementLineId));
}

async function resolveProfile(ctx: Context, bankAccountId: string) {
  const profiles = await ctx.bankAccounts.list(ctx.orgId, {
    includeInactive: true,
    page: 1,
    pageSize: 100,
  });
  const existing = profiles.items.find((p) => p.accountId === bankAccountId);
  if (existing) return existing;

  return ctx.bankAccounts.create(ctx.orgId, ctx.userId, {
    accountId: bankAccountId,
    displayName: "Primary current account",
    bankName: "Demo Bank",
    countryCode: "IN",
    identifierScheme: "IFSC_ACCOUNT",
    identifierValue: "000123456789",
    branchIdentifier: "DEMO0000001",
    csvMappingPreset: PRESET,
  });
}

export async function seedBankReconciliation(
  ctx: Context,
  receiptIds: readonly string[],
  paymentId: string,
): Promise<BankOutcome> {
  const bankAccountId = await accountIdFor(ctx, CODE.bank);
  const profile = await resolveProfile(ctx, bankAccountId);

  const settlements = await loadSettlements(ctx, receiptIds, paymentId);
  const openingMinor = await ctx.bankAccounts.glBalanceMinor(ctx.bookId, bankAccountId, DAY_BEFORE_OPEN);
  const closingMinor = settlements.reduce((total, row) => total + row.amountMinor, openingMinor);

  const imported = await ctx.statements.listStatements(ctx.orgId, {
    bankProfileId: profile.id,
    page: 1,
    pageSize: 100,
  });
  const found = imported.items.find((s) => s.fileName === BANK_FILE_NAME);

  const statementId = found
    ? found.id
    : (
        await ctx.statements.import(ctx.orgId, ctx.userId, {
          bankProfileId: profile.id,
          fileName: BANK_FILE_NAME,
          content: buildCsv(settlements, profile.currency),
          presetCode: PRESET,
          periodStart: BOOKS_OPEN_ON,
          periodEnd: QUARTER_END,
          opening: toDecimalString(money(openingMinor, profile.currency)),
          closing: toDecimalString(money(closingMinor, profile.currency)),
        })
      ).statementId;

  const statement = await ctx.statements.getStatement(ctx.orgId, statementId);
  const matched = await matchedLineIds(ctx, statement.lines.map((line) => line.id));

  for (const line of statement.lines) {
    if (matched.has(line.id)) continue;
    const row = settlements.find((s) => s.amountMinor === line.amountMinor);
    if (!row) continue;
    await ctx.matching.match(ctx.orgId, ctx.userId, line.id, row.counterpart);
  }

  const proof = await ctx.reconciliation.getRecProof(ctx.orgId, statementId);
  if (!proof.holds) return { reconciled: false, explanation: proof.explanation };

  const marked = await ctx.reconciliation.markReconciled(ctx.orgId, ctx.userId, statementId);
  return { reconciled: marked.reconciledAt !== null, explanation: marked.explanation };
}
