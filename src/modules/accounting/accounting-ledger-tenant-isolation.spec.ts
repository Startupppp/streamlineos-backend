jest.mock("./ar/lib/invoice-pdf", () => ({
  ...jest.requireActual("./ar/lib/invoice-pdf"),
  generateInvoicePdf: jest.fn(async () => Buffer.from("%PDF-rendered")),
}));

import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  arDocuments,
  glAccounts,
  glBooks,
  glJournalLines,
  glJournals,
  organizations,
  taxRegistrations,
} from "../../db/schema";
import { tenantDb, type TenantFixture } from "../../test/tenant-recorder";
import { ArDocumentPdfService } from "./ar/ar-document-pdf.service";
import { AccountsService } from "./kernel/accounts.service";
import { BooksService } from "./kernel/books.service";
import { AccountingSetupService } from "./setup/accounting-setup.service";
import { OpeningBalancesService } from "./setup/opening-balances.service";

/**
 * Cross-tenant isolation for the ledger-facing accounting services the kernel
 * lane brought in: the chart of accounts, accounting setup, opening balances
 * and the AR document PDF.
 *
 * The attacker names the OWNER's book, account, journal and document ids. The
 * double answers each statement by the equalities it bound, so a missing org
 * predicate hands back the owner's row; each deny case asserts that it did not,
 * and that the org (or, for the book-scoped setup reads, the book) bound in the
 * statement is the caller's own.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const ownerAccount = (id: string, code: string, systemTag: string | null) => ({
  orgId: OWNER_ORG,
  bookId: "book-owner",
  id,
  code,
  name: code === "1000" ? "Cash" : "Retained earnings",
  accountType: code === "1000" ? "ASSET" : "EQUITY",
  parentAccountId: null,
  isHeader: false,
  isActive: true,
  isCash: code === "1000",
  systemTag,
  currencyRestriction: null,
  description: null,
  deletedAt: null,
});

const bookRow = (orgId: string, id: string) => ({
  orgId,
  id,
  isDefault: true,
  deletedAt: null,
  name: `${orgId} books`,
  countryCode: "IN",
  baseCurrency: "INR",
  localizationPack: "IN",
  fiscalYearStartMonth: 4,
  fiscalYearStartDay: 1,
  timezone: "Asia/Kolkata",
  status: "active",
});

function store(extra: TenantFixture[] = []) {
  return tenantDb({
    fixtures: [
      {
        table: glAccounts,
        org: glAccounts.orgId,
        rows: [ownerAccount("acc-owner", "1000", null), ownerAccount("acc-re-owner", "3000", "retained_earnings")],
      },
      {
        table: glJournalLines,
        org: glJournalLines.orgId,
        rows: [{ orgId: OWNER_ORG, bookId: "book-owner", accountId: "acc-owner", debitMinor: "5000", creditMinor: "1000" }],
      },
      {
        table: glJournals,
        org: glJournals.orgId,
        rows: [{ orgId: OWNER_ORG, bookId: "book-owner", idempotencyKey: "opening_balance:book-owner:post", id: "jr-ob-owner" }],
      },
      ...extra,
    ],
  });
}

describe("AccountsService — cross-tenant isolation", () => {
  const audit = { log: jest.fn() };

  it("deny: listing another org's book id returns none of its chart of accounts", async () => {
    const t = store();
    const tree = await new AccountsService(t.db, audit as never).list(ATTACKER_ORG, "book-owner");

    expect(tree).toEqual([]);
    expect(t.orgBound(t.on(glAccounts, "select")[0], glAccounts.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: another org's account id is a 404", async () => {
    const t = store();

    await expect(
      new AccountsService(t.db, audit as never).get(ATTACKER_ORG, "book-owner", "acc-owner"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(t.orgBound(t.on(glAccounts, "select")[0], glAccounts.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: the balance of another org's account sums none of its postings", async () => {
    const t = store();
    const balance = await new AccountsService(t.db, audit as never).balance(
      ATTACKER_ORG,
      "book-owner",
      "acc-owner",
      "2026-03-31",
    );

    expect(balance).toEqual({ debitMinor: 0, creditMinor: 0, balanceMinor: 0 });
    expect(t.orgBound(t.on(glJournalLines, "select")[0], glJournalLines.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org lists, reads and balances its own account", async () => {
    const t = store();
    const service = new AccountsService(t.db, audit as never);

    expect((await service.list(OWNER_ORG, "book-owner")).map((node) => node.id)).toContain("acc-owner");
    expect(await service.get(OWNER_ORG, "book-owner", "acc-owner")).toMatchObject({ id: "acc-owner" });
    expect(await service.balance(OWNER_ORG, "book-owner", "acc-owner", "2026-03-31")).toEqual({
      debitMinor: 5000,
      creditMinor: 1000,
      balanceMinor: 4000,
    });
  });
});

describe("OpeningBalancesService — cross-tenant isolation", () => {
  const INPUT = { asOfDate: "2026-04-01", lines: [{ accountId: "acc-owner", amountMinor: 1000 }] };

  function build(t: ReturnType<typeof store>) {
    const books = {
      requireDefault: jest.fn(async (orgId: string) => ({
        id: orgId === OWNER_ORG ? "book-owner" : "book-attacker",
        baseCurrency: "INR",
      })),
    };
    const ledger = { post: jest.fn(async () => ({ id: "jr-new", replayed: false, totalDebitMinor: 1000 })) };
    const audit = { log: jest.fn() };
    return { ledger, service: new OpeningBalancesService(t.db, books as never, ledger as never, audit as never) };
  }

  it("deny: isPosted does not see another org's opening-balance journal for the same book id", async () => {
    const t = store();

    expect(await build(t).service.isPosted(ATTACKER_ORG, "book-owner")).toBe(false);
    expect(t.orgBound(t.on(glJournals, "select")[0], glJournals.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: opening balances cannot be posted against another org's GL account", async () => {
    const t = store();
    const o = build(t);

    await expect(o.service.post(ATTACKER_ORG, "usr-attacker", INPUT)).rejects.toThrow(BadRequestException);
    await expect(o.service.post(ATTACKER_ORG, "usr-attacker", INPUT)).rejects.toThrow(/not in this book/);
    expect(o.ledger.post).not.toHaveBeenCalled();
    expect(t.orgBound(t.on(glAccounts, "select")[0], glAccounts.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org previews its own opening balances, balanced to its own retained earnings", async () => {
    const t = store();
    const preview = await build(t).service.preview(OWNER_ORG, INPUT);

    expect(preview).toMatchObject({
      totalDebitMinor: 1000,
      differenceMinor: 1000,
      balancingAccountCode: "3000",
      alreadyPosted: true,
    });
  });
});

describe("AccountingSetupService — cross-tenant isolation", () => {
  const OWNER_REGISTRATION = {
    orgId: OWNER_ORG,
    bookId: "book-owner",
    ownerType: "book",
    id: "reg-owner",
    regime: "GST",
    number: "29AAAAA0000A1Z5",
    region: "KA",
    countryCode: "IN",
    isPrimary: true,
  };

  /**
   * The real BooksService resolves the caller's default book, so the setup
   * service's book-scoped reads are only as isolated as that lookup — which is
   * exactly the path under test.
   */
  function build(bookRows: Array<Record<string, unknown>>) {
    const t = store([
      { table: glBooks, org: glBooks.orgId, rows: bookRows },
      { table: taxRegistrations, org: taxRegistrations.orgId, rows: [OWNER_REGISTRATION] },
    ]);
    const packs = { get: jest.fn(() => ({ status: "enabled", code: "IN" })) };
    const books = new BooksService(t.db, packs as never);
    const access = { isModuleEnabled: jest.fn(async () => false) };
    const periods = { listFiscalYears: jest.fn(async () => []) };
    const service = new AccountingSetupService(
      t.db,
      books,
      {} as never,
      packs as never,
      { log: jest.fn() } as never,
      access as never,
      periods as never,
    );
    return { t, access, periods, service };
  }

  it("deny: status for an org with no book never reports another org's book", async () => {
    const s = build([bookRow(OWNER_ORG, "book-owner")]);

    const status = await s.service.status(ATTACKER_ORG);

    expect(status.enabled).toBe(false);
    expect(s.t.orgBound(s.t.on(glBooks, "select")[0], glBooks.orgId)).toEqual([ATTACKER_ORG]);
    expect(s.access.isModuleEnabled).toHaveBeenCalledWith(ATTACKER_ORG, "accounting");
    expect(s.periods.listFiscalYears).not.toHaveBeenCalled();
    expect(s.t.statements.filter((st) => st.op === "execute")).toHaveLength(0);
  });

  it("deny: listTaxRegistrations reads only the caller's own book, never another org's registrations", async () => {
    const s = build([bookRow(OWNER_ORG, "book-owner"), bookRow(ATTACKER_ORG, "book-attacker")]);

    const registrations = await s.service.listTaxRegistrations(ATTACKER_ORG);

    expect(registrations).toEqual([]);
    const [read] = s.t.on(taxRegistrations, "select");
    expect(s.t.orgBound(read, taxRegistrations.bookId)).toEqual(["book-attacker"]);
  });

  it("control: the owning org sees its own book and tax registration", async () => {
    const s = build([bookRow(OWNER_ORG, "book-owner"), bookRow(ATTACKER_ORG, "book-attacker")]);

    const status = await s.service.status(OWNER_ORG);
    expect(status.enabled).toBe(true);
    expect(status.enabled && status.book.id).toBe("book-owner");
    expect((await s.service.listTaxRegistrations(OWNER_ORG)).map((r) => r.id)).toEqual(["reg-owner"]);
  });
});

describe("ArDocumentPdfService — cross-tenant isolation", () => {
  const DOC = "doc-1";
  const view = {
    id: DOC,
    bookId: "book-x",
    partyId: "party-x",
    documentType: "INVOICE",
    status: "POSTED",
    documentNumber: "INV-0001",
    issueDate: "2026-03-10",
    dueDate: "2026-04-09",
    currency: "INR",
    supplyNature: "taxable",
    taxLocationFromCountry: "IN",
    taxLocationFromRegion: "KA",
    taxLocationToCountry: "IN",
    taxLocationToRegion: "KA",
    placeOfSupplyCode: "29",
    originalDocumentId: null,
    lines: [],
    netMinor: 1000,
    taxMinor: 180,
    grossMinor: 1180,
    roundingMinor: 0,
    memo: null,
    reference: null,
  };

  function build(opts: { documentGet?: (orgId: string) => Promise<unknown> } = {}) {
    const t = store([
      {
        table: arDocuments,
        org: arDocuments.orgId,
        rows: [{ orgId: OWNER_ORG, id: DOC, deletedAt: null, pdfStorageKey: "owner/INV-0001.pdf", pdfStorageUrl: "https://files/owner" }],
      },
    ]);
    const documents = {
      get: jest.fn(opts.documentGet ?? (async () => view)),
      frozenTaxLines: jest.fn(async () => []),
    };
    const parties = {
      get: jest.fn(async () => ({
        displayName: "Customer",
        legalName: null,
        taxRegistrations: [],
        billingLine1: null,
        billingLine2: null,
        billingCity: null,
        billingRegion: null,
        billingPostalCode: null,
        billingCountryCode: "IN",
        countryCode: "IN",
        email: null,
        phone: null,
      })),
    };
    const tax = { loadRegistrations: jest.fn(async () => []) };
    const storage = {
      isConfigured: () => true,
      getFileStream: jest.fn(async () => ({
        body: (async function* body() {
          yield Buffer.from("%PDF-stored");
        })(),
      })),
      uploadFile: jest.fn(async () => ({ key: "new-key", url: "https://files/new-key" })),
    };
    const service = new ArDocumentPdfService(t.db, documents as never, parties as never, tax as never, storage as never);
    return { t, documents, parties, storage, service };
  }

  it("deny: another org's document id is a 404 before any PDF is read, rendered or stored", async () => {
    const p = build({
      documentGet: async (orgId) => {
        if (orgId !== OWNER_ORG) throw new NotFoundException("Document not found");
        return view;
      },
    });

    await expect(p.service.render(ATTACKER_ORG, DOC, "INVOICE" as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(p.documents.get).toHaveBeenCalledWith(ATTACKER_ORG, DOC);
    expect(p.storage.getFileStream).not.toHaveBeenCalled();
    expect(p.storage.uploadFile).not.toHaveBeenCalled();
    expect(p.t.on(arDocuments)).toHaveLength(0);
  });

  it("deny: a stored PDF recorded under another org is never served, and every read and write is the caller's org", async () => {
    const p = build();

    const rendered = await p.service.render(ATTACKER_ORG, DOC, "INVOICE" as never);

    expect(rendered.fromStore).toBe(false);
    expect(p.storage.getFileStream).not.toHaveBeenCalled();
    const [cachedRead] = p.t.on(arDocuments, "select");
    expect(p.t.orgBound(cachedRead, arDocuments.orgId)).toEqual([ATTACKER_ORG]);
    expect(p.t.orgBound(p.t.on(arDocuments, "update")[0], arDocuments.orgId)).toEqual([ATTACKER_ORG]);
    expect(p.t.orgBound(p.t.on(glBooks, "select")[0], glBooks.orgId)).toEqual([ATTACKER_ORG]);
    expect(p.t.orgBound(p.t.on(organizations, "select")[0], organizations.id)).toEqual([ATTACKER_ORG]);
    expect((p.storage.uploadFile.mock.calls[0] as unknown[])[0]).toBe(ATTACKER_ORG);
    expect(p.parties.get).toHaveBeenCalledWith(ATTACKER_ORG, "party-x");
    expect(p.documents.frozenTaxLines).toHaveBeenCalledWith(ATTACKER_ORG, DOC);
  });

  it("control: the owning org gets its own stored PDF back", async () => {
    const p = build();

    const rendered = await p.service.render(OWNER_ORG, DOC, "INVOICE" as never);

    expect(rendered.fromStore).toBe(true);
    expect(p.storage.getFileStream).toHaveBeenCalledWith(OWNER_ORG, "owner/INV-0001.pdf");
  });
});
