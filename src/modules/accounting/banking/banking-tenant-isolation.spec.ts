import { NotFoundException } from "@nestjs/common";
import { bankMatches, bankProfiles, bankStatementLines, bankStatements, glJournalLines } from "../../../db/schema";
import { tenantDb } from "../../../test/tenant-recorder";
import { BankAccountsService, type BankAccountSummary } from "./bank-accounts.service";
import { MatchingService } from "./matching.service";
import { ReconciliationService } from "./reconciliation.service";
import { StatementImportService } from "./statement-import.service";

/**
 * Cross-tenant isolation for the bank-reconciliation half of the accounting
 * kernel: bank accounts, imported statements, matching and the reconciliation
 * proof.
 *
 * The fixtures hold the OWNER's rows, and the attacker asks for them by id —
 * the owner's bank profile, statement, statement line, matched line, and a cash
 * account named by the owner's book and GL account. The double answers each
 * statement by the predicates it bound, so without the org predicate the
 * owner's row comes back; each deny case asserts both that it did not and that
 * the org bound in that statement was the caller's.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const OWNER_PROFILE = {
  id: "bp-owner",
  orgId: OWNER_ORG,
  bookId: "book-owner",
  accountId: "acc-bank-owner",
  displayName: "Owner current account",
  bankName: "Owner Bank",
  currency: "INR",
  countryCode: "IN",
  identifierScheme: null,
  identifierValue: null,
  branchIdentifier: null,
  csvMapping: null,
  isActive: true,
};
/** The shape `get` and `list` project: the profile row, plus the GL account's code and name. */
const OWNER_PROFILE_ROW = {
  orgId: OWNER_ORG,
  id: "bp-owner",
  bookId: "book-owner",
  isActive: true,
  profile: OWNER_PROFILE,
  accountCode: "1010",
  accountName: "Bank",
  total: 1,
};

const statementRow = (orgId: string, id: string, closingMinor: number) => ({
  orgId,
  id,
  bankProfileId: orgId === OWNER_ORG ? "bp-owner" : "bp-attacker",
  bookId: orgId === OWNER_ORG ? "book-owner" : "book-attacker",
  currency: "INR",
  periodStart: "2026-03-01",
  periodEnd: "2026-03-31",
  openingMinor: 0,
  closingMinor,
  source: "csv",
  fileName: "march.csv",
  fileHash: `hash-${id}`,
  reconciledAt: null,
  reconciledBy: null,
  importedAt: new Date("2026-04-01T00:00:00Z"),
  lineCount: 1,
  total: 1,
});

const OWNER_LINE = {
  orgId: OWNER_ORG,
  id: "line-owner",
  statementId: "st-owner",
  lineNo: 1,
  valueDate: "2026-03-05",
  amountMinor: 125_000,
  description: "NEFT owner customer",
  bankReference: "UTR-OWNER",
  bankProfileId: "bp-owner",
  periodStart: "2026-03-01",
  periodEnd: "2026-03-31",
};

const OWNER_CASH_LINE = {
  orgId: OWNER_ORG,
  bookId: "book-owner",
  accountId: "acc-bank-owner",
  txnCurrency: "INR",
  journalId: "jr-owner",
  journalNumber: "JV-0001",
  journalDate: "2026-03-05",
  memo: "Owner receipt",
  sourceType: "ar_receipt",
  sourceId: "rcpt-owner",
  lineId: "jl-owner",
  lineNo: 1,
  debitMinor: 125_000,
  txnAmountMinor: 125_000,
  functionalAmountMinor: 125_000,
  creditMinor: 0,
  description: null,
};

const OWNER_MATCH = {
  orgId: OWNER_ORG,
  id: "match-owner",
  statementLineId: "line-owner",
  bookId: "book-owner",
  kind: "journal",
  receiptId: null,
  paymentId: null,
  journalId: "jr-owner",
};

function store() {
  return tenantDb({
    fixtures: [
      { table: bankProfiles, org: bankProfiles.orgId, rows: [OWNER_PROFILE_ROW] },
      {
        table: bankStatements,
        org: bankStatements.orgId,
        rows: [statementRow(OWNER_ORG, "st-owner", 125_000), statementRow(ATTACKER_ORG, "st-attacker", 0)],
      },
      { table: bankStatementLines, org: bankStatementLines.orgId, rows: [OWNER_LINE] },
      { table: glJournalLines, org: glJournalLines.orgId, rows: [OWNER_CASH_LINE] },
      { table: bankMatches, org: bankMatches.orgId, rows: [OWNER_MATCH] },
    ],
  });
}

const booksDouble = () => ({ get: jest.fn(async () => ({ baseCurrency: "INR" })) });

describe("BankAccountsService — cross-tenant isolation", () => {
  it("deny: another org's bank profile id is a 404, never its summary", async () => {
    const t = store();

    await expect(new BankAccountsService(t.db, booksDouble() as never).get(ATTACKER_ORG, "bp-owner")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.orgBound(t.on(bankProfiles, "select")[0], bankProfiles.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: list shows the attacker none of another org's bank accounts", async () => {
    const t = store();
    const page = await new BankAccountsService(t.db, booksDouble() as never).list(ATTACKER_ORG);

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(t.orgBound(t.on(bankProfiles, "select")[0], bankProfiles.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org reads and lists its own bank account", async () => {
    const t = store();
    const service = new BankAccountsService(t.db, booksDouble() as never);

    expect(await service.get(OWNER_ORG, "bp-owner")).toMatchObject({ id: "bp-owner", accountCode: "1010" });
    expect((await service.list(OWNER_ORG)).items.map((item) => item.id)).toEqual(["bp-owner"]);
  });
});

describe("StatementImportService — cross-tenant isolation", () => {
  const service = (t: ReturnType<typeof store>) => new StatementImportService(t.db, {} as never);

  it("deny: another org's statement id is a 404 and none of its lines are read", async () => {
    const t = store();

    await expect(service(t).getStatement(ATTACKER_ORG, "st-owner")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.orgBound(t.on(bankStatements, "select")[0], bankStatements.orgId)).toEqual([ATTACKER_ORG]);
    expect(t.on(bankStatementLines)).toHaveLength(0);
  });

  it("deny: listStatements shows the attacker only its own statements", async () => {
    const t = store();
    const page = await service(t).listStatements(ATTACKER_ORG);

    expect(page.items.map((item) => item.id)).toEqual(["st-attacker"]);
    expect(t.orgBound(t.on(bankStatements, "select")[0], bankStatements.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org reads its own statement and its lines", async () => {
    const t = store();
    const statement = await service(t).getStatement(OWNER_ORG, "st-owner");

    expect(statement.id).toBe("st-owner");
    expect(statement.lines.map((line) => line.id)).toEqual(["line-owner"]);
    expect(t.orgBound(t.on(bankStatementLines, "select")[0], bankStatementLines.orgId)).toEqual([OWNER_ORG]);
  });
});

describe("MatchingService — cross-tenant isolation", () => {
  const OWNER_SHAPED_PROFILE = {
    id: "bp-owner",
    bookId: "book-owner",
    accountId: "acc-bank-owner",
    currency: "INR",
  } as BankAccountSummary;

  function build(t: ReturnType<typeof store>) {
    const bankAccounts = { get: jest.fn(async () => OWNER_SHAPED_PROFILE) };
    return { bankAccounts, service: new MatchingService(t.db, bankAccounts as never) };
  }

  it("deny: another org's statement line is a 404 and its bank profile is never resolved", async () => {
    const t = store();
    const m = build(t);

    await expect(m.service.requireStatementLine(ATTACKER_ORG, "line-owner")).rejects.toBeInstanceOf(NotFoundException);
    expect(m.bankAccounts.get).not.toHaveBeenCalled();
    expect(t.orgBound(t.on(bankStatementLines, "select")[0], bankStatementLines.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: unmatchedStatementLines for another org's statement id returns nothing", async () => {
    const t = store();
    const lines = await build(t).service.unmatchedStatementLines(ATTACKER_ORG, { statementId: "st-owner" });

    expect(lines).toEqual([]);
    expect(t.orgBound(t.on(bankStatementLines, "select")[0], bankStatementLines.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: cashJournalLines named with another org's book and GL account returns none of its postings", async () => {
    const t = store();
    const lines = await build(t).service.cashJournalLines(ATTACKER_ORG, OWNER_SHAPED_PROFILE, { to: "2026-03-31" });

    expect(lines).toEqual([]);
    expect(t.orgBound(t.on(glJournalLines, "select")[0], glJournalLines.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: unmatch on another org's matched line is a 404 and deletes nothing", async () => {
    const t = store();

    await expect(build(t).service.unmatch(ATTACKER_ORG, "line-owner")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.orgBound(t.on(bankMatches, "select")[0], bankMatches.orgId)).toEqual([ATTACKER_ORG]);
    expect(t.on(bankMatches, "delete")).toHaveLength(0);
  });

  it("control: the owning org sees its own unmatched line and cash posting", async () => {
    const t = store();
    const m = build(t);

    expect((await m.service.unmatchedStatementLines(OWNER_ORG, { statementId: "st-owner" })).map((l) => l.id)).toEqual([
      "line-owner",
    ]);
    expect((await m.service.cashJournalLines(OWNER_ORG, OWNER_SHAPED_PROFILE, { to: "2026-03-31" })).map((l) => l.lineId)).toEqual([
      "jl-owner",
    ]);
  });
});

describe("ReconciliationService — cross-tenant isolation", () => {
  /** Collaborators that record the org they were asked for; a zero balance so the proof holds. */
  function collaborators(orgId: string) {
    const suffix = orgId === OWNER_ORG ? "owner" : "attacker";
    return {
      books: booksDouble(),
      bankAccounts: {
        get: jest.fn(async () => ({ id: `bp-${suffix}`, bookId: `book-${suffix}`, accountId: `acc-${suffix}`, currency: "INR" })),
        glBalanceMinor: jest.fn(async () => 0),
      },
      matching: {
        cashJournalLines: jest.fn(async () => []),
        unmatchedStatementLines: jest.fn(async () => []),
      },
    };
  }

  function build(t: ReturnType<typeof store>, orgId: string) {
    const c = collaborators(orgId);
    const statements = new StatementImportService(t.db, {} as never);
    const service = new ReconciliationService(t.db, c.books as never, c.bankAccounts as never, statements, c.matching as never);
    return { ...c, service };
  }

  it("deny: the proof for another org's statement id is a 404, and nothing about its account is read", async () => {
    const t = store();
    const r = build(t, ATTACKER_ORG);

    await expect(r.service.getRecProof(ATTACKER_ORG, "st-owner")).rejects.toBeInstanceOf(NotFoundException);
    expect(r.bankAccounts.get).not.toHaveBeenCalled();
    expect(r.bankAccounts.glBalanceMinor).not.toHaveBeenCalled();
    expect(r.matching.cashJournalLines).not.toHaveBeenCalled();
  });

  it("deny: markReconciled stamps only a statement in the caller's org, and asks every collaborator as the caller", async () => {
    const t = store();
    const r = build(t, ATTACKER_ORG);

    await r.service.markReconciled(ATTACKER_ORG, "usr-attacker", "st-attacker");

    const [stamp] = t.on(bankStatements, "update");
    expect(t.orgBound(stamp, bankStatements.orgId)).toEqual([ATTACKER_ORG]);
    expect(r.bankAccounts.get).toHaveBeenCalledWith(ATTACKER_ORG, "bp-attacker");
    expect(r.books.get).toHaveBeenCalledWith(ATTACKER_ORG, "book-attacker");
    for (const call of r.matching.cashJournalLines.mock.calls as unknown[][]) expect(call[0]).toBe(ATTACKER_ORG);
    for (const call of r.matching.unmatchedStatementLines.mock.calls as unknown[][]) expect(call[0]).toBe(ATTACKER_ORG);
  });

  it("control: the owning org's balanced statement is marked reconciled in its own org", async () => {
    const t = store();
    const r = build(t, OWNER_ORG);
    r.bankAccounts.glBalanceMinor.mockResolvedValue(125_000);

    const proof = await r.service.markReconciled(OWNER_ORG, "usr-owner", "st-owner");

    expect(proof.holds).toBe(true);
    expect(t.orgBound(t.on(bankStatements, "update")[0], bankStatements.orgId)).toEqual([OWNER_ORG]);
  });
});
