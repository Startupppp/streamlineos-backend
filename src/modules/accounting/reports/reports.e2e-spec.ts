/**
 * Reporting acceptance suite — PRD 06.
 *
 * Built on the PRD's **SeedCo** golden fixture: capital 100,000, an invoice of
 * 11,800 (10,000 + 18% GST), a bill of 5,900 (5,000 + 18% GST), a receipt of
 * 11,800 and a payment of 5,900. The numbers that come out the other side are
 * known in advance, so a report that drifts fails here rather than in front of
 * an accountant.
 *
 * Fixtures are posted through `LedgerService.post()` — the only writer of
 * `gl_journals` — and the AR/AP sub-ledger rows are inserted directly, because
 * ageing reads open items and this suite deliberately does not depend on the
 * AR/AP services being finished.
 *
 * Everything runs against a real Postgres. Half of what is being proven (that
 * a locked period is still readable, that a computed equity line makes the
 * sheet balance) does not exist in a mock.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import {
  apDocuments,
  arDocuments,
  glAccounts,
  glParties,
  glPeriods,
  organizationMembers,
  organizations,
  taxDocumentLines,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService } from "../kernel/sequence.service";
import { addDays } from "../kernel/fiscal-calendar";
import { AgingService, bucketFor } from "./aging.service";
import { BalanceSheetService } from "./balance-sheet.service";
import { CashFlowService } from "./cash-flow.service";
import { ProfitLossService } from "./profit-loss.service";
import { TaxSummaryService } from "./tax-summary.service";
import { TrialBalanceService } from "./trial-balance.service";
import { REPORT_LABELS } from "./report-labels";

/* ------------------------------------------------------------- constants */

/** FY 2026-27 under the India pack: 1 April 2026 to 31 March 2027. */
const FY_START = "2026-04-01";
const FY_END = "2027-03-31";
const PRIOR_FY_START = "2025-04-01";

const CAPITAL_DATE = "2026-04-01";
const INVOICE_DATE = "2026-05-10";
const BILL_DATE = "2026-05-20";
const RECEIPT_DATE = "2026-06-05";
const PAYMENT_DATE = "2026-06-15";
const AS_OF = "2026-06-30";

/** Paise. 100,000.00 INR. */
const CAPITAL = 10_000_000;
const INVOICE_NET = 1_000_000; //  10,000.00
const INVOICE_TAX = 180_000; //     1,800.00
const INVOICE_GROSS = 1_180_000; // 11,800.00
const BILL_NET = 500_000; //         5,000.00
const BILL_TAX = 90_000; //            900.00
const BILL_GROSS = 590_000; //       5,900.00

/** IN pack chart codes the fixture posts against. */
const CODE = {
  bank: "1020",
  ar: "1100",
  inputIgst: "1220",
  accumDepreciation: "1590",
  ap: "2100",
  outputIgst: "2220",
  shareCapital: "3100",
  sales: "4100",
  opex: "5300",
  depreciation: "5900",
} as const;

/* --------------------------------------------------------------- harness */

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;

let trialBalance: TrialBalanceService;
let profitLoss: ProfitLossService;
let balanceSheet: BalanceSheetService;
let cashFlow: CashFlowService;
let aging: AgingService;
let taxSummary: TaxSummaryService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * A tenant the way the platform really makes one. `organizations` and
 * `organization_members` carry mutually dependent FKs; the constraint is
 * DEFERRABLE, so both rows go in one transaction and are checked at commit.
 */
async function seedOrg(): Promise<string> {
  const orgId = `acc-test-${crypto.randomUUID()}`;
  const userId = `acc-user-${crypto.randomUUID()}`;
  createdOrgIds.push(orgId);
  createdUserIds.push(userId);

  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ id: userId, email: `${userId}@accounting.test` })
      .onConflictDoNothing();
    await tx
      .insert(organizations)
      .values({ id: orgId, name: orgId, slug: orgId, ownerMembershipId: 0 })
      .onConflictDoNothing();
    const [membership] = await tx
      .insert(organizationMembers)
      .values({ orgId, userId, isOwner: true })
      .returning({ id: organizationMembers.id });
    await tx
      .update(organizations)
      .set({ ownerMembershipId: membership.id })
      .where(eq(organizations.id, orgId));
  });

  return orgId;
}

interface Fixture {
  orgId: string;
  bookId: string;
  accounts: Record<string, string>;
  partyId: string;
}

async function freshBook(openFrom = FY_START): Promise<Fixture> {
  const orgId = await seedOrg();
  const book = await books.enable(orgId, null, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    openFrom,
  });

  const rows = await db
    .select({ id: glAccounts.id, code: glAccounts.code })
    .from(glAccounts)
    .where(eq(glAccounts.bookId, book.id));
  const accounts = Object.fromEntries(rows.map((r) => [r.code, r.id]));

  const [party] = await db
    .insert(glParties)
    .values({
      orgId,
      bookId: book.id,
      role: "both",
      displayName: "Acme Trading Co",
      countryCode: "IN",
      defaultCurrency: "INR",
    })
    .returning({ id: glParties.id });

  return { orgId, bookId: book.id, accounts, partyId: party!.id };
}

/** SeedCo, exactly as the PRD describes it, posted through the kernel. */
async function seedCo(): Promise<Fixture & { invoiceId: string; billId: string }> {
  const fixture = await freshBook();
  const { orgId, bookId, accounts, partyId } = fixture;
  const a = (code: string) => accounts[code]!;

  await ledger.post(orgId, null, {
    bookId,
    idempotencyKey: `opening_balance:${orgId}:capital`,
    journalDate: CAPITAL_DATE,
    memo: "Founder capital",
    sourceType: "opening_balance",
    lines: [
      { accountId: a(CODE.bank), debitMinor: CAPITAL },
      { accountId: a(CODE.shareCapital), creditMinor: CAPITAL },
    ],
  });

  const invoiceJournal = await ledger.post(orgId, null, {
    bookId,
    idempotencyKey: `sales_invoice:${orgId}-inv-1:post`,
    journalDate: INVOICE_DATE,
    memo: "INV-0001",
    sourceType: "sales_invoice",
    lines: [
      { accountId: a(CODE.ar), debitMinor: INVOICE_GROSS, partyId },
      { accountId: a(CODE.sales), creditMinor: INVOICE_NET },
      { accountId: a(CODE.outputIgst), creditMinor: INVOICE_TAX },
    ],
  });

  const billJournal = await ledger.post(orgId, null, {
    bookId,
    idempotencyKey: `purchase_bill:${orgId}-bill-1:post`,
    journalDate: BILL_DATE,
    memo: "BILL-0001",
    sourceType: "purchase_bill",
    lines: [
      { accountId: a(CODE.opex), debitMinor: BILL_NET },
      { accountId: a(CODE.inputIgst), debitMinor: BILL_TAX },
      { accountId: a(CODE.ap), creditMinor: BILL_GROSS, partyId },
    ],
  });

  await ledger.post(orgId, null, {
    bookId,
    idempotencyKey: `receipt:${orgId}-rcpt-1:post`,
    journalDate: RECEIPT_DATE,
    memo: "Receipt against INV-0001",
    sourceType: "receipt",
    lines: [
      { accountId: a(CODE.bank), debitMinor: INVOICE_GROSS },
      { accountId: a(CODE.ar), creditMinor: INVOICE_GROSS, partyId },
    ],
  });

  await ledger.post(orgId, null, {
    bookId,
    idempotencyKey: `payment:${orgId}-pay-1:post`,
    journalDate: PAYMENT_DATE,
    memo: "Payment against BILL-0001",
    sourceType: "payment",
    lines: [
      { accountId: a(CODE.ap), debitMinor: BILL_GROSS, partyId },
      { accountId: a(CODE.bank), creditMinor: BILL_GROSS },
    ],
  });

  // The sub-ledger rows ageing reads. Both fully settled, so SeedCo's ageing
  // is empty — which is the assertion, not an omission.
  const [invoice] = await db
    .insert(arDocuments)
    .values({
      orgId,
      bookId,
      partyId,
      documentType: "INVOICE",
      status: "PAID",
      documentNumber: "INV-0001",
      issueDate: INVOICE_DATE,
      dueDate: addDays(INVOICE_DATE, 30),
      currency: "INR",
      netMinor: INVOICE_NET,
      taxMinor: INVOICE_TAX,
      grossMinor: INVOICE_GROSS,
      functionalGrossMinor: INVOICE_GROSS,
      settledMinor: INVOICE_GROSS,
      postedJournalId: invoiceJournal.id,
      postedAt: new Date(),
    })
    .returning({ id: arDocuments.id });

  const [bill] = await db
    .insert(apDocuments)
    .values({
      orgId,
      bookId,
      partyId,
      documentType: "BILL",
      status: "PAID",
      documentNumber: "BILL-0001",
      vendorDocumentNumber: "V-77",
      issueDate: BILL_DATE,
      dueDate: addDays(BILL_DATE, 30),
      currency: "INR",
      netMinor: BILL_NET,
      taxMinor: BILL_TAX,
      grossMinor: BILL_GROSS,
      functionalGrossMinor: BILL_GROSS,
      settledMinor: BILL_GROSS,
      postedJournalId: billJournal.id,
      postedAt: new Date(),
    })
    .returning({ id: apDocuments.id });

  // Frozen tax lines, exactly as `TaxService.freezeDocumentTaxLines` writes them.
  await db.insert(taxDocumentLines).values([
    {
      orgId,
      bookId,
      documentType: "sales_invoice",
      documentId: invoice!.id,
      component: "IGST",
      jurisdiction: "IN",
      rateBp: 1800,
      taxableMinor: INVOICE_NET,
      taxMinor: INVOICE_TAX,
      currency: "INR",
      glRole: "output_payable",
      recoverable: false,
      glAccountId: a(CODE.outputIgst),
    },
    {
      orgId,
      bookId,
      documentType: "purchase_bill",
      documentId: bill!.id,
      component: "IGST",
      jurisdiction: "IN",
      rateBp: 1800,
      taxableMinor: BILL_NET,
      taxMinor: BILL_TAX,
      currency: "INR",
      glRole: "input_recoverable",
      recoverable: true,
      glAccountId: a(CODE.inputIgst),
    },
  ]);

  return { ...fixture, invoiceId: invoice!.id, billId: bill!.id };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for the reporting acceptance suite");
  client = postgres(url, { prepare: false, max: 5 });
  db = drizzle(client, { schema }) as unknown as Db;

  const packs = new PackRegistry();
  books = new BooksService(db, packs);
  ledger = new LedgerService(db, new SequenceService(db), packs);

  trialBalance = new TrialBalanceService(db, books);
  profitLoss = new ProfitLossService(db, books);
  balanceSheet = new BalanceSheetService(db, books);
  cashFlow = new CashFlowService(db, books);
  aging = new AgingService(db, books);
  taxSummary = new TaxSummaryService(db, books);
});

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client?.end({ timeout: 5 });
});

/* ------------------------------------------------------- golden fixture */

describe("SeedCo golden fixture", () => {
  let co: Awaited<ReturnType<typeof seedCo>>;

  beforeAll(async () => {
    co = await seedCo();
  });

  it("trial balance is balanced and carries the golden closing balances", async () => {
    const report = await trialBalance.run(co.orgId, { asOf: AS_OF });

    expect(report.balanced).toBe(true);
    expect(report.differenceMinor).toBe(0);
    expect(report.totalDebitMinor).toBe(report.totalCreditMinor);

    const byCode = Object.fromEntries(
      report.lines.map((l) => [l.code, l.debitMinor - l.creditMinor]),
    );
    // 100,000 in, 11,800 in, 5,900 out.
    expect(byCode[CODE.bank]).toBe(CAPITAL + INVOICE_GROSS - BILL_GROSS);
    expect(byCode[CODE.ar] ?? 0).toBe(0);
    expect(byCode[CODE.ap] ?? 0).toBe(0);
    expect(byCode[CODE.shareCapital]).toBe(-CAPITAL);
    expect(byCode[CODE.sales]).toBe(-INVOICE_NET);
    expect(byCode[CODE.opex]).toBe(BILL_NET);
  });

  it("hides zero-activity accounts by default and shows them on request", async () => {
    const hidden = await trialBalance.run(co.orgId, { asOf: AS_OF });
    const shown = await trialBalance.run(co.orgId, {
      asOf: AS_OF,
      includeZeroActivity: true,
    });

    expect(hidden.lines.length).toBeLessThan(shown.lines.length);
    // The IN chart has far more accounts than SeedCo has touched.
    expect(shown.lines.length).toBeGreaterThan(20);
    expect(hidden.lines.every((l) => l.movementDebitMinor + l.movementCreditMinor > 0)).toBe(true);
    // Showing every account cannot change whether the ledger balances.
    expect(shown.balanced).toBe(true);
    expect(shown.totalDebitMinor).toBe(hidden.totalDebitMinor);
  });

  it("profit and loss shows revenue 10,000 and expense 5,000", async () => {
    const report = await profitLoss.run(co.orgId, { from: FY_START, to: AS_OF });

    expect(report.income.totalMinor).toBe(INVOICE_NET);
    expect(report.expense.totalMinor).toBe(BILL_NET);
    expect(report.netProfitMinor).toBe(INVOICE_NET - BILL_NET);

    const sales = report.income.lines.find((l) => l.code === CODE.sales);
    expect(sales?.amountMinor).toBe(INVOICE_NET);
    // Tax is never income: the 1,800 collected belongs to the authority.
    expect(report.income.lines.some((l) => l.code === CODE.outputIgst)).toBe(false);
  });

  it("balance sheet bank is 100,000 + 11,800 - 5,900, and it balances", async () => {
    const report = await balanceSheet.run(co.orgId, { asOf: AS_OF });

    const bank = report.assets.lines.find((l) => l.code === CODE.bank);
    expect(bank?.amountMinor).toBe(CAPITAL + INVOICE_GROSS - BILL_GROSS);
    expect(bank?.amountMinor).toBe(10_590_000);

    const ar = report.assets.lines.find((l) => l.code === CODE.ar);
    expect(ar?.amountMinor ?? 0).toBe(0);
    const ap = report.liabilities.lines.find((l) => l.code === CODE.ap);
    expect(ap?.amountMinor ?? 0).toBe(0);

    expect(report.balanced).toBe(true);
    expect(report.differenceMinor).toBe(0);
    expect(report.totalAssetsMinor).toBe(
      report.totalLiabilitiesMinor + report.totalEquityMinor,
    );
  });

  it("rolls current-year earnings into equity as a computed line, not a posting", async () => {
    const report = await balanceSheet.run(co.orgId, { asOf: AS_OF });
    const pnl = await profitLoss.run(co.orgId, { from: FY_START, to: AS_OF });

    const cye = report.equity.lines.find((l) => l.tag === "current_year_earnings");
    expect(cye).toBeDefined();
    expect(cye!.computed).toBe(true);
    expect(cye!.accountId).toBeNull();
    expect(cye!.amountMinor).toBe(INVOICE_NET - BILL_NET);
    // The computed line is the P&L. It cannot be anything else.
    expect(report.currentYearEarningsMinor).toBe(pnl.netProfitMinor);

    // And nothing was posted to the tagged account to make that true.
    const tb = await trialBalance.run(co.orgId, { asOf: AS_OF, includeZeroActivity: true });
    const account3300 = tb.lines.find((l) => l.code === "3300");
    expect(account3300?.movementDebitMinor).toBe(0);
    expect(account3300?.movementCreditMinor).toBe(0);

    // Without the computed line the sheet would be out by exactly the profit.
    const postedEquity = report.equity.lines
      .filter((l) => !l.computed)
      .reduce((t, l) => t + l.amountMinor, 0);
    expect(report.totalAssetsMinor - report.totalLiabilitiesMinor - postedEquity).toBe(
      INVOICE_NET - BILL_NET,
    );
  });

  it("ageing is empty and still reconciles to the control accounts", async () => {
    for (const side of ["ar", "ap"] as const) {
      const report = await aging.run(co.orgId, { side, asOf: AS_OF });
      expect(report.parties).toHaveLength(0);
      expect(report.totalOpenMinor).toBe(0);
      expect(report.controlAccountBalanceMinor).toBe(0);
      expect(report.reconciles).toBe(true);
      expect(report.differenceMinor).toBe(0);
      expect(report.controlAccountCode).toBe(side === "ar" ? CODE.ar : CODE.ap);
    }
  });

  it("cash flow reconciles opening cash + net movement to closing cash", async () => {
    const report = await cashFlow.run(co.orgId, { from: FY_START, to: AS_OF });

    expect(report.openingCashMinor).toBe(0);
    expect(report.closingCashMinor).toBe(CAPITAL + INVOICE_GROSS - BILL_GROSS);
    expect(report.openingCashMinor + report.netMovementMinor).toBe(report.closingCashMinor);
    expect(report.reconciles).toBe(true);
    expect(report.reconciliationDifferenceMinor).toBe(0);

    expect(report.netIncomeMinor).toBe(INVOICE_NET - BILL_NET);
    // AR and AP opened and closed inside the window, so neither tied up cash.
    const wc = report.sections.find((s) => s.key === "working_capital")!;
    expect(wc.lines.find((l) => l.key === "ar_movement")!.amountMinor).toBe(0);
    expect(wc.lines.find((l) => l.key === "ap_movement")!.amountMinor).toBe(0);
    // 1,800 collected less 900 reclaimable is cash held for the authority.
    expect(wc.lines.find((l) => l.key === "tax_movement")!.amountMinor).toBe(
      INVOICE_TAX - BILL_TAX,
    );
    // The capital injection is financing, which v1 does not classify — so it
    // has to show up here rather than being smuggled into operating cash.
    expect(report.otherMovementsMinor).toBe(CAPITAL);
    expect(report.operatingCashMinor).toBe(INVOICE_NET - BILL_NET + INVOICE_TAX - BILL_TAX);
  });

  it("cash flow says what it does not model, in the payload", async () => {
    const report = await cashFlow.run(co.orgId, { from: FY_START, to: AS_OF });

    expect(Array.isArray(report.limitations)).toBe(true);
    expect(report.limitations.length).toBeGreaterThanOrEqual(5);
    expect(report.limitations.join(" ")).toContain("investing");
    expect(report.limitations.join(" ")).toContain("Inventory");
    expect(report.sections.some((s) => s.key === "unmodelled")).toBe(true);
  });

  it("tax summary reads the frozen lines by component and gl role", async () => {
    const report = await taxSummary.run(co.orgId, { from: FY_START, to: AS_OF });

    const output = report.rows.find((r) => r.glRole === "output_payable");
    const input = report.rows.find((r) => r.glRole === "input_recoverable");
    expect(output).toMatchObject({
      component: "IGST",
      jurisdiction: "IN",
      rateBp: 1800,
      taxableMinor: INVOICE_NET,
      taxMinor: INVOICE_TAX,
      documentCount: 1,
    });
    expect(input).toMatchObject({ taxableMinor: BILL_NET, taxMinor: BILL_TAX });

    expect(report.totals.outputTaxMinor).toBe(INVOICE_TAX);
    expect(report.totals.recoverableInputTaxMinor).toBe(BILL_TAX);
    expect(report.totals.netPayableMinor).toBe(INVOICE_TAX - BILL_TAX);
    expect(report.byComponent).toEqual([
      { component: "IGST", taxableMinor: INVOICE_NET + BILL_NET, taxMinor: INVOICE_TAX + BILL_TAX },
    ]);
  });

  it("tax summary scopes to the document date, not when the row was written", async () => {
    // Both documents were inserted a moment ago; a `created_at` window would
    // put them in today's period rather than May 2026.
    const inPeriod = await taxSummary.run(co.orgId, { from: "2026-05-01", to: "2026-05-31" });
    expect(inPeriod.totals.taxMinor).toBe(INVOICE_TAX + BILL_TAX);

    const outOfPeriod = await taxSummary.run(co.orgId, { from: "2026-07-01", to: "2026-07-31" });
    expect(outOfPeriod.rows).toHaveLength(0);
    expect(outOfPeriod.totals.netPayableMinor).toBe(0);
  });
});

/* ------------------------------------------------------------- ageing */

describe("AR ageing with an unpaid invoice", () => {
  const ASK_DATE = "2026-08-31";
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await freshBook();
    const a = (code: string) => fixture.accounts[code]!;
    await books.ensureFiscalYear(fixture.orgId, fixture.bookId, ASK_DATE);

    // Due 45 days before the as-of date, so it lands squarely in 31-60.
    const dueDate = addDays(ASK_DATE, -45);
    const issueDate = addDays(dueDate, -30);

    const journal = await ledger.post(fixture.orgId, null, {
      bookId: fixture.bookId,
      idempotencyKey: `sales_invoice:${fixture.orgId}-late:post`,
      journalDate: issueDate,
      sourceType: "sales_invoice",
      lines: [
        { accountId: a(CODE.ar), debitMinor: INVOICE_GROSS, partyId: fixture.partyId },
        { accountId: a(CODE.sales), creditMinor: INVOICE_NET },
        { accountId: a(CODE.outputIgst), creditMinor: INVOICE_TAX },
      ],
    });

    await db.insert(arDocuments).values({
      orgId: fixture.orgId,
      bookId: fixture.bookId,
      partyId: fixture.partyId,
      documentType: "INVOICE",
      status: "POSTED",
      documentNumber: "INV-LATE-1",
      issueDate,
      dueDate,
      currency: "INR",
      netMinor: INVOICE_NET,
      taxMinor: INVOICE_TAX,
      grossMinor: INVOICE_GROSS,
      functionalGrossMinor: INVOICE_GROSS,
      settledMinor: 0,
      postedJournalId: journal.id,
      postedAt: new Date(),
    });
  });

  it("puts a 45-day-old invoice in 31-60 and ties that to the AR control account", async () => {
    const report = await aging.run(fixture.orgId, { side: "ar", asOf: ASK_DATE });

    expect(report.totals["31-60"]).toBe(INVOICE_GROSS);
    expect(report.totals["0-30"]).toBe(0);
    expect(report.totals["61-90"]).toBe(0);
    expect(report.totals["91+"]).toBe(0);
    expect(report.totalOpenMinor).toBe(INVOICE_GROSS);

    // The assertion that matters: the bucket equals the general ledger.
    expect(report.controlAccountBalanceMinor).toBe(INVOICE_GROSS);
    expect(report.totals["31-60"]).toBe(report.controlAccountBalanceMinor);
    expect(report.reconciles).toBe(true);
    expect(report.differenceMinor).toBe(0);

    expect(report.parties).toHaveLength(1);
    expect(report.parties[0]).toMatchObject({
      partyName: "Acme Trading Co",
      totalMinor: INVOICE_GROSS,
      documentCount: 1,
      oldestAgeDays: 45,
    });
    expect(report.parties[0]!.buckets["31-60"]).toBe(INVOICE_GROSS);
  });

  it("ages by issue date when asked, which moves the same invoice further out", async () => {
    const byDue = await aging.run(fixture.orgId, { side: "ar", asOf: ASK_DATE, basis: "due" });
    const byIssue = await aging.run(fixture.orgId, { side: "ar", asOf: ASK_DATE, basis: "issue" });

    expect(byDue.basis).toBe("due");
    expect(byIssue.basis).toBe("issue");
    // Issued 30 days before it was due: 45 + 30 = 75 days old.
    expect(byIssue.totals["61-90"]).toBe(INVOICE_GROSS);
    expect(byIssue.totals["31-60"]).toBe(0);
    // Whichever basis is chosen, the total still ties to the ledger.
    expect(byIssue.reconciles).toBe(true);
    expect(byIssue.totalOpenMinor).toBe(byDue.totalOpenMinor);
  });

  it("returns document detail only when asked, with the bucket on each row", async () => {
    const summaryOnly = await aging.run(fixture.orgId, { side: "ar", asOf: ASK_DATE });
    expect(summaryOnly.documents).toBeNull();

    const withDocs = await aging.run(fixture.orgId, {
      side: "ar",
      asOf: ASK_DATE,
      includeDocuments: true,
    });
    expect(withDocs.documents).toHaveLength(1);
    expect(withDocs.documents![0]).toMatchObject({
      documentNumber: "INV-LATE-1",
      bucket: "31-60",
      ageDays: 45,
      openMinor: INVOICE_GROSS,
      functionalOpenMinor: INVOICE_GROSS,
    });
  });

  it("buckets on the documented boundaries", () => {
    expect(bucketFor(-10)).toBe("0-30");
    expect(bucketFor(0)).toBe("0-30");
    expect(bucketFor(30)).toBe("0-30");
    expect(bucketFor(31)).toBe("31-60");
    expect(bucketFor(60)).toBe("31-60");
    expect(bucketFor(61)).toBe("61-90");
    expect(bucketFor(90)).toBe("61-90");
    expect(bucketFor(91)).toBe("91+");
    expect(bucketFor(3650)).toBe("91+");
  });
});

/* ------------------------------------------------- fiscal year boundary */

describe("fiscal year boundaries", () => {
  const PRIOR_REVENUE = 700_000;
  const THIS_YEAR_REVENUE = 400_000;
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await freshBook(PRIOR_FY_START);
    await books.ensureFiscalYear(fixture.orgId, fixture.bookId, FY_START);
    const a = (code: string) => fixture.accounts[code]!;

    await ledger.post(fixture.orgId, null, {
      bookId: fixture.bookId,
      idempotencyKey: `manual:${fixture.orgId}-prior:post`,
      journalDate: "2025-09-15",
      memo: "Last year's sale",
      sourceType: "manual",
      lines: [
        { accountId: a(CODE.bank), debitMinor: PRIOR_REVENUE },
        { accountId: a(CODE.sales), creditMinor: PRIOR_REVENUE },
      ],
    });

    await ledger.post(fixture.orgId, null, {
      bookId: fixture.bookId,
      idempotencyKey: `manual:${fixture.orgId}-current:post`,
      journalDate: "2026-05-15",
      memo: "This year's sale",
      sourceType: "manual",
      lines: [
        { accountId: a(CODE.bank), debitMinor: THIS_YEAR_REVENUE },
        { accountId: a(CODE.sales), creditMinor: THIS_YEAR_REVENUE },
      ],
    });
  });

  it("excludes a prior fiscal year from the profit and loss", async () => {
    const report = await profitLoss.run(fixture.orgId, { from: FY_START, to: FY_END });

    expect(report.income.totalMinor).toBe(THIS_YEAR_REVENUE);
    expect(report.netProfitMinor).toBe(THIS_YEAR_REVENUE);
    expect(report.fiscalYear.startsOn).toBe(FY_START);
    expect(report.fiscalYear.endsOn).toBe(FY_END);
  });

  it("clamps a range that reaches back into a prior fiscal year, and says so", async () => {
    const report = await profitLoss.run(fixture.orgId, { from: PRIOR_FY_START, to: FY_END });

    expect(report.requestedFrom).toBe(PRIOR_FY_START);
    expect(report.from).toBe(FY_START);
    expect(report.clampedToFiscalYear).toBe(true);
    expect(report.income.totalMinor).toBe(THIS_YEAR_REVENUE);
    expect(report.notes.join(" ")).toContain(FY_START);
  });

  it("returns the raw multi-year range only when explicitly asked", async () => {
    const report = await profitLoss.run(fixture.orgId, {
      from: PRIOR_FY_START,
      to: FY_END,
      clampToFiscalYear: false,
    });

    expect(report.clampedToFiscalYear).toBe(false);
    expect(report.income.totalMinor).toBe(PRIOR_REVENUE + THIS_YEAR_REVENUE);
    expect(report.notes.join(" ")).toContain("more than one fiscal year");
  });

  it("balances the sheet with prior-year and current-year earnings both computed", async () => {
    const report = await balanceSheet.run(fixture.orgId, { asOf: AS_OF });

    expect(report.priorYearEarningsMinor).toBe(PRIOR_REVENUE);
    expect(report.currentYearEarningsMinor).toBe(THIS_YEAR_REVENUE);
    expect(report.balanced).toBe(true);
    expect(report.differenceMinor).toBe(0);
    expect(report.totalAssetsMinor).toBe(PRIOR_REVENUE + THIS_YEAR_REVENUE);

    const prior = report.equity.lines.find((l) => l.tag === "prior_year_earnings");
    expect(prior?.computed).toBe(true);
    expect(prior?.amountMinor).toBe(PRIOR_REVENUE);
    // Neither computed line is a posting.
    expect(report.equity.lines.filter((l) => l.computed).every((l) => l.accountId === null)).toBe(
      true,
    );
  });

  it("offers a comparative column against the immediately preceding period", async () => {
    const report = await profitLoss.run(fixture.orgId, {
      from: FY_START,
      to: FY_END,
      comparative: true,
    });

    expect(report.comparative).toEqual({ from: PRIOR_FY_START, to: "2026-03-31" });
    expect(report.income.priorTotalMinor).toBe(PRIOR_REVENUE);
    expect(report.priorNetProfitMinor).toBe(PRIOR_REVENUE);

    const sales = report.income.lines.find((l) => l.code === CODE.sales)!;
    expect(sales.amountMinor).toBe(THIS_YEAR_REVENUE);
    expect(sales.priorAmountMinor).toBe(PRIOR_REVENUE);
    expect(sales.varianceMinor).toBe(THIS_YEAR_REVENUE - PRIOR_REVENUE);
  });
});

/* ------------------------------------------------------- locked periods */

describe("locked periods", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await freshBook();
    const a = (code: string) => fixture.accounts[code]!;

    await ledger.post(fixture.orgId, null, {
      bookId: fixture.bookId,
      idempotencyKey: `manual:${fixture.orgId}-locked:post`,
      journalDate: "2026-04-10",
      sourceType: "manual",
      lines: [
        { accountId: a(CODE.bank), debitMinor: 250_000 },
        { accountId: a(CODE.sales), creditMinor: 250_000 },
      ],
    });

    await db
      .update(glPeriods)
      .set({ status: "LOCKED", lockedAt: new Date(), lockReason: "Year-end close" })
      .where(
        and(eq(glPeriods.bookId, fixture.bookId), eq(glPeriods.startsOn, "2026-04-01")),
      );
  });

  it("still reports a locked period — closed to posting is not closed to reading", async () => {
    const [locked] = await db
      .select({ status: glPeriods.status })
      .from(glPeriods)
      .where(and(eq(glPeriods.bookId, fixture.bookId), eq(glPeriods.startsOn, "2026-04-01")))
      .limit(1);
    expect(locked!.status).toBe("LOCKED");

    const tb = await trialBalance.run(fixture.orgId, { asOf: "2026-04-30" });
    expect(tb.balanced).toBe(true);
    expect(tb.lines.find((l) => l.code === CODE.bank)?.debitMinor).toBe(250_000);

    const pnl = await profitLoss.run(fixture.orgId, { from: "2026-04-01", to: "2026-04-30" });
    expect(pnl.income.totalMinor).toBe(250_000);

    const bs = await balanceSheet.run(fixture.orgId, { asOf: "2026-04-30" });
    expect(bs.balanced).toBe(true);
    expect(bs.currentYearEarningsMinor).toBe(250_000);

    const cf = await cashFlow.run(fixture.orgId, { from: "2026-04-01", to: "2026-04-30" });
    expect(cf.reconciles).toBe(true);
    expect(cf.closingCashMinor).toBe(250_000);
  });

  it("still posts a locked period as unavailable — the lock is real", async () => {
    const a = (code: string) => fixture.accounts[code]!;
    await expect(
      ledger.post(fixture.orgId, null, {
        bookId: fixture.bookId,
        idempotencyKey: `manual:${fixture.orgId}-after-lock:post`,
        journalDate: "2026-04-11",
        sourceType: "manual",
        lines: [
          { accountId: a(CODE.bank), debitMinor: 100 },
          { accountId: a(CODE.sales), creditMinor: 100 },
        ],
      }),
    ).rejects.toThrow(/locked/i);
  });
});

/* --------------------------------------------------- non-cash and contra */

describe("depreciation, contra accounts and cash flow", () => {
  const ASSET_COST = 1_200_000;
  const DEPRECIATION = 100_000;
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await freshBook();
    const a = (code: string) => fixture.accounts[code]!;

    await ledger.post(fixture.orgId, null, {
      bookId: fixture.bookId,
      idempotencyKey: `opening_balance:${fixture.orgId}-asset:post`,
      journalDate: "2026-04-02",
      sourceType: "opening_balance",
      lines: [
        { accountId: a("1500"), debitMinor: ASSET_COST },
        { accountId: a(CODE.shareCapital), creditMinor: ASSET_COST },
      ],
    });

    await ledger.post(fixture.orgId, null, {
      bookId: fixture.bookId,
      idempotencyKey: `depreciation:${fixture.orgId}-m1:post`,
      journalDate: "2026-04-30",
      sourceType: "depreciation",
      lines: [
        { accountId: a(CODE.depreciation), debitMinor: DEPRECIATION },
        { accountId: a(CODE.accumDepreciation), creditMinor: DEPRECIATION },
      ],
    });
  });

  it("shows accumulated depreciation as a negative asset, not a liability", async () => {
    const report = await balanceSheet.run(fixture.orgId, { asOf: "2026-04-30" });

    const accum = report.assets.lines.find((l) => l.code === CODE.accumDepreciation);
    expect(accum).toBeDefined();
    expect(accum!.isContra).toBe(true);
    expect(accum!.amountMinor).toBe(-DEPRECIATION);
    expect(report.liabilities.lines.some((l) => l.code === CODE.accumDepreciation)).toBe(false);

    expect(report.totalAssetsMinor).toBe(ASSET_COST - DEPRECIATION);
    expect(report.currentYearEarningsMinor).toBe(-DEPRECIATION);
    expect(report.balanced).toBe(true);
  });

  it("adds depreciation back as a non-cash item in the cash flow", async () => {
    const report = await cashFlow.run(fixture.orgId, { from: FY_START, to: "2026-04-30" });

    expect(report.netIncomeMinor).toBe(-DEPRECIATION);
    expect(report.nonCashMinor).toBe(DEPRECIATION);
    const nonCash = report.sections.find((s) => s.key === "non_cash")!;
    expect(nonCash.lines).toHaveLength(1);
    expect(nonCash.lines[0]!.key).toBe("depreciation");
    expect(nonCash.lines[0]!.accountCodes).toEqual([CODE.depreciation]);
    // The two cancel: depreciation never touched the bank.
    expect(report.operatingCashMinor).toBe(0);
    expect(report.closingCashMinor).toBe(0);
    expect(report.reconciles).toBe(true);
  });
});

/* --------------------------------------------------------------- labels */

describe("founder and accountant labels", () => {
  let co: Awaited<ReturnType<typeof seedCo>>;

  beforeAll(async () => {
    co = await seedCo();
  });

  it("changes the words and nothing else", async () => {
    const founder = await balanceSheet.run(co.orgId, { asOf: AS_OF, labelMode: "founder" });
    const accountant = await balanceSheet.run(co.orgId, { asOf: AS_OF, labelMode: "accountant" });

    expect(founder.assets.label).toBe("What we own");
    expect(accountant.assets.label).toBe("Assets");
    expect(founder.liabilities.label).toBe("What we owe");
    expect(accountant.liabilities.label).toBe("Liabilities");
    expect(accountant.title).toBe("Balance sheet");

    // Same numbers, different words. This is the whole promise of the toggle.
    expect(founder.totalAssetsMinor).toBe(accountant.totalAssetsMinor);
    expect(founder.currentYearEarningsMinor).toBe(accountant.currentYearEarningsMinor);
    expect(founder.assets.lines.map((l) => l.amountMinor)).toEqual(
      accountant.assets.lines.map((l) => l.amountMinor),
    );
  });

  it("names AR and AP the way a founder would ask about them", async () => {
    const ar = await aging.run(co.orgId, { side: "ar", asOf: AS_OF, labelMode: "founder" });
    const ap = await aging.run(co.orgId, { side: "ap", asOf: AS_OF, labelMode: "founder" });
    expect(ar.title).toBe("What customers owe us");
    expect(ap.title).toBe("What we owe suppliers");

    const pnl = await profitLoss.run(co.orgId, { from: FY_START, to: AS_OF, labelMode: "founder" });
    expect(pnl.income.label).toBe("Money in");
    expect(pnl.expense.label).toBe("Money out");
  });

  it("carries both wordings for every label in the catalog", () => {
    const entries = Object.entries(REPORT_LABELS);
    expect(entries.length).toBeGreaterThan(40);
    for (const [key, pair] of entries) {
      expect(typeof pair.founder).toBe("string");
      expect(typeof pair.accountant).toBe("string");
      expect(pair.founder.length).toBeGreaterThan(0);
      expect(pair.accountant.length).toBeGreaterThan(0);
      expect(key).toMatch(/^[a-z_]+\.[A-Za-z0-9_+-]+$/);
    }
  });
});

/* ------------------------------------------------------------------ csv */

describe("CSV export", () => {
  let co: Awaited<ReturnType<typeof seedCo>>;

  beforeAll(async () => {
    co = await seedCo();
  });

  it("exports every report with a preamble and decimal money", async () => {
    const tb = await trialBalance.csv(co.orgId, { asOf: AS_OF });
    expect(tb).toContain('Report,"Every account, checked"');
    expect(tb).toContain("As of,2026-06-30");
    expect(tb).toContain("Balanced,yes");
    expect(tb).toContain("105900.00");
    expect(tb.split("\r\n").length).toBeGreaterThan(5);

    const pnl = await profitLoss.csv(co.orgId, { from: FY_START, to: AS_OF });
    expect(pnl).toContain("10000.00");
    expect(pnl).toContain("5000.00");

    const bs = await balanceSheet.csv(co.orgId, { asOf: AS_OF });
    expect(bs).toContain("computed");
    expect(bs).toContain("Balanced,yes");

    const cf = await cashFlow.csv(co.orgId, { from: FY_START, to: AS_OF });
    expect(cf).toContain("Method,Indirect");
    expect(cf).toContain("Limitation 1,");

    const ar = await aging.csv(co.orgId, { side: "ar", asOf: AS_OF });
    expect(ar).toContain("Reconciles,yes");

    const tax = await taxSummary.csv(co.orgId, { from: FY_START, to: AS_OF });
    expect(tax).toContain("IGST");
    expect(tax).toContain("Net payable,900.00");
  });

  it("quotes a party name containing a comma and defuses a formula", async () => {
    const fixture = await freshBook();
    const a = (code: string) => fixture.accounts[code]!;
    const [party] = await db
      .insert(glParties)
      .values({
        orgId: fixture.orgId,
        bookId: fixture.bookId,
        role: "customer",
        displayName: '=cmd|"/c calc"!A1, Smith & Co',
        countryCode: "IN",
        defaultCurrency: "INR",
      })
      .returning({ id: glParties.id });

    const journal = await ledger.post(fixture.orgId, null, {
      bookId: fixture.bookId,
      idempotencyKey: `sales_invoice:${fixture.orgId}-csv:post`,
      journalDate: INVOICE_DATE,
      sourceType: "sales_invoice",
      lines: [
        { accountId: a(CODE.ar), debitMinor: INVOICE_GROSS, partyId: party!.id },
        { accountId: a(CODE.sales), creditMinor: INVOICE_NET },
        { accountId: a(CODE.outputIgst), creditMinor: INVOICE_TAX },
      ],
    });
    await db.insert(arDocuments).values({
      orgId: fixture.orgId,
      bookId: fixture.bookId,
      partyId: party!.id,
      documentType: "INVOICE",
      status: "POSTED",
      documentNumber: "INV-CSV-1",
      issueDate: INVOICE_DATE,
      dueDate: addDays(INVOICE_DATE, 30),
      currency: "INR",
      netMinor: INVOICE_NET,
      taxMinor: INVOICE_TAX,
      grossMinor: INVOICE_GROSS,
      functionalGrossMinor: INVOICE_GROSS,
      settledMinor: 0,
      postedJournalId: journal.id,
      postedAt: new Date(),
    });

    const csv = await aging.csv(fixture.orgId, { side: "ar", asOf: AS_OF });
    // The whole cell is quoted, and the leading `=` is neutralised.
    expect(csv).toContain(`"'=cmd|""/c calc""!A1, Smith & Co"`);
  });
});

/* --------------------------------------------------------- multi-tenancy */

describe("tenant isolation", () => {
  it("cannot read another organization's book, and says 404 rather than 403", async () => {
    const mine = await freshBook();
    const theirs = await freshBook();

    await expect(
      trialBalance.run(mine.orgId, { asOf: AS_OF, bookId: theirs.bookId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      balanceSheet.run(mine.orgId, { asOf: AS_OF, bookId: theirs.bookId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      aging.run(mine.orgId, { side: "ar", asOf: AS_OF, bookId: theirs.bookId }),
    ).rejects.toThrow(/not found/i);
  });

  it("never leaks another organization's postings into a report", async () => {
    const noisy = await seedCo();
    const quiet = await freshBook();

    const tb = await trialBalance.run(quiet.orgId, { asOf: AS_OF });
    expect(tb.lines).toHaveLength(0);
    expect(tb.totalDebitMinor).toBe(0);
    expect(tb.balanced).toBe(true);

    const bs = await balanceSheet.run(quiet.orgId, { asOf: AS_OF });
    expect(bs.totalAssetsMinor).toBe(0);
    expect(bs.balanced).toBe(true);

    // And the noisy tenant still sees its own numbers.
    const theirs = await trialBalance.run(noisy.orgId, { asOf: AS_OF });
    expect(theirs.totalDebitMinor).toBeGreaterThan(0);
  });

  it("reports nothing rather than throwing when accounting was never enabled", async () => {
    const orgId = await seedOrg();
    await expect(trialBalance.run(orgId, { asOf: AS_OF })).rejects.toThrow(
      /accounting is not enabled/i,
    );
  });
});
