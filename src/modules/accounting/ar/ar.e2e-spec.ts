/**
 * Sales / AR acceptance suite — the hard gate from `02-prd-sales-ar.md`.
 *
 * Every numbered `describe` below is one of the PRD's acceptance tests, plus the
 * invariant the whole layer rests on: **the AR control account equals the sum of
 * open items**. If that ever stops being true, the aging report is fiction and
 * the balance sheet is wrong, so it is asserted explicitly rather than implied.
 *
 * These run against a real Postgres. Half of what is being proven — the partial
 * uniques, the settled/gross CHECK, concurrent idempotency, `FOR UPDATE`
 * serialisation — does not exist in a mock.
 *
 * Services are constructed with `new` rather than through Nest DI; there is no
 * request context to build and booting `AppModule` would cost more than the
 * suite does.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { ConflictException, BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import { glBookCurrencies } from "../../../db/schema";
import {
  arDocuments,
  glAccounts,
  glFxRates,
  glJournals,
  organizationMembers,
  organizations,
  taxDocumentLines,
  taxRegistrations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService } from "../kernel/sequence.service";
import { addDays } from "../kernel/fiscal-calendar";
import { TaxEngineRegistry } from "../tax/tax-engine.registry";
import { TaxService } from "../tax/tax.service";
import { PartiesService } from "../parties/parties.service";
import { ComplianceService } from "../compliance/compliance.service";
import { ArDocumentsService, computeLineNetMinor } from "./ar-documents.service";
import { ArReceiptsService } from "./ar-receipts.service";
import { ArAgingService } from "./ar-aging.service";
import type { CreateInvoiceInput } from "./dto/ar-documents.schemas";

const AS_OF = "2026-08-25";
const USER_ID = null;

/** Karnataka. The seller sits here in every India fixture. */
const KARNATAKA = "29";
/** Maharashtra — a different state, so the supply is inter-state. */
const MAHARASHTRA = "27";

const SELLER_GSTIN = "29AABCU9603R1ZM";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;
let tax: TaxService;
let parties: PartiesService;
let documents: ArDocumentsService;
let receipts: ArReceiptsService;
let aging: ArAgingService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * Create a tenant the way the platform really does.
 *
 * `organizations.owner_membership_id` carries a composite FK back to
 * `organization_members`, so the two rows are mutually dependent. The constraint
 * is DEFERRABLE INITIALLY DEFERRED precisely for this.
 */
async function seedOrg(): Promise<string> {
  const orgId = `ar-test-${crypto.randomUUID()}`;
  const userId = `ar-user-${crypto.randomUUID()}`;
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
  baseCurrency: string;
}

/** A fresh org with a book, a seeded tax pack and (for India) a seller GSTIN. */
async function freshBook(
  pack: "IN" | "GENERIC_VAT" = "IN",
  currency = "INR",
  countryCode = pack === "IN" ? "IN" : "PT",
): Promise<Fixture> {
  const orgId = await seedOrg();
  const book = await books.enable(orgId, USER_ID, {
    countryCode,
    packCode: pack,
    baseCurrency: currency,
    openFrom: AS_OF,
  });
  await tax.seedPack(orgId, book.id, pack);

  if (pack === "IN") {
    await db.insert(taxRegistrations).values({
      orgId,
      ownerType: "book",
      bookId: book.id,
      regime: "GST_IN",
      number: SELLER_GSTIN,
      region: KARNATAKA,
      countryCode: "IN",
      isPrimary: true,
    });
  }

  return { orgId, bookId: book.id, baseCurrency: currency };
}

async function customer(
  fixture: Fixture,
  options: {
    name?: string;
    region?: string | null;
    countryCode?: string;
    currency?: string;
    gstin?: string;
    paymentTermsDays?: number;
  } = {},
): Promise<string> {
  const countryCode = options.countryCode ?? "IN";
  const party = await parties.create(fixture.orgId, USER_ID, {
    displayName: options.name ?? "Acme Industries",
    countryCode,
    defaultCurrency: options.currency ?? fixture.baseCurrency,
    billingRegion: options.region ?? null,
    billingCountryCode: countryCode,
    paymentTermsDays: options.paymentTermsDays ?? 30,
  });

  if (options.gstin) {
    await parties.addRegistration(fixture.orgId, party.id, {
      regime: "GST_IN",
      number: options.gstin,
      countryCode: "IN",
    });
  }
  return party.id;
}

/** One 100.00 line unless the caller says otherwise. */
function invoiceInput(partyId: string, overrides: Partial<CreateInvoiceInput> = {}) {
  return {
    partyId,
    issueDate: AS_OF,
    lines: [
      {
        description: "Consulting services",
        quantityMilli: 1000,
        unitPriceMinor: 10_000,
        commodityCode: "998313",
      },
    ],
    ...overrides,
  } satisfies CreateInvoiceInput;
}

async function postInvoice(
  fixture: Fixture,
  partyId: string,
  overrides: Partial<CreateInvoiceInput> = {},
) {
  const draft = await documents.createInvoice(
    fixture.orgId,
    USER_ID,
    invoiceInput(partyId, overrides),
  );
  return documents.post(fixture.orgId, USER_ID, draft.id);
}

/** Trial balance as a `code -> signed balance` map, for terse assertions. */
async function trialBalance(fixture: Fixture, asOf = "2027-03-31"): Promise<Record<string, number>> {
  const rows = await ledger.trialBalance(fixture.orgId, fixture.bookId, asOf);
  return Object.fromEntries(rows.map((r) => [r.code, r.balanceMinor]));
}

async function accountId(bookId: string, code: string): Promise<string> {
  const [row] = await db
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(and(eq(glAccounts.bookId, bookId), eq(glAccounts.code, code)))
    .limit(1);
  if (!row) throw new Error(`Test fixture is missing account ${code}`);
  return row.id;
}

async function bankAccountId(bookId: string): Promise<string> {
  return accountId(bookId, "1020");
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for the AR acceptance suite");
  client = postgres(url, { prepare: false, max: 6 });
  db = drizzle(client, { schema }) as unknown as Db;

  const packs = new PackRegistry();
  const sequences = new SequenceService(db);
  books = new BooksService(db, packs);
  ledger = new LedgerService(db, sequences, packs);
  tax = new TaxService(db, new TaxEngineRegistry());
  parties = new PartiesService(db, books);
  const compliance = new ComplianceService(db);
  documents = new ArDocumentsService(db, books, ledger, sequences, packs, tax, parties, compliance);
  receipts = new ArReceiptsService(db, books, ledger, sequences, packs, parties);
  aging = new ArAgingService(db, books);
});

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    // Everything accounting owns cascades from the org row.
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client?.end({ timeout: 5 });
});

/* ---------------------------------------------------------------- line maths */

describe("line arithmetic", () => {
  it("multiplies thousandths by minor units and rounds half-up", () => {
    // 2.5 hours at 100.00 = 250.00
    expect(computeLineNetMinor(2500, 10_000, 0)).toBe(25_000);
    // 1/3 of an hour at 100.00 = 33.33 (33.333… rounds up on the third)
    expect(computeLineNetMinor(333, 10_000, 0)).toBe(3_330);
    // Half a paisa rounds away from zero, never toward it.
    expect(computeLineNetMinor(1, 5, 0)).toBe(0);
    expect(computeLineNetMinor(1, 500, 0)).toBe(1);
    // The discount comes off after the multiply, not before.
    expect(computeLineNetMinor(2000, 10_000, 5_000)).toBe(15_000);
  });
});

/* ------------------------------------------------------------ acceptance 1 */

describe("1 — INR intra-state 18% invoice", () => {
  it("posts AR 118, income 100, CGST 9 and SGST 9", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, {
      region: KARNATAKA,
      gstin: "29AAACX1234C1ZP",
    });

    const { document, journal } = await postInvoice(fixture, partyId);

    expect(document.status).toBe("POSTED");
    expect(document.netMinor).toBe(10_000);
    expect(document.taxMinor).toBe(1_800);
    expect(document.grossMinor).toBe(11_800);
    expect(document.documentNumber).toMatch(/^INV\/2026-27\/\d{4}$/);
    expect(document.gstrPeriod).toBe("2026-08");
    expect(document.functionalGrossMinor).toBe(11_800);
    expect(journal.sourceType).toBe("sales_invoice");

    const tb = await trialBalance(fixture);
    expect(tb["1100"]).toBe(11_800); // AR control, debit
    expect(tb["4100"]).toBe(-10_000); // Sales, credit
    expect(tb["2200"]).toBe(-900); // Output CGST
    expect(tb["2210"]).toBe(-900); // Output SGST
    expect(tb["2220"]).toBeUndefined(); // no IGST on an intra-state supply

    // The engine's verdict is frozen against the document, not re-derived later.
    const frozen = await documents.frozenTaxLines(fixture.orgId, document.id);
    expect(frozen.map((f) => f.component).sort()).toEqual(["CGST", "SGST"]);
    expect(frozen.every((f) => f.glRole === "output_payable")).toBe(true);
  });

  it("splits tax out of a tax-inclusive line instead of adding to it", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });

    // 118.00 inclusive of 18% is 100.00 net plus 18.00 tax.
    const { document } = await postInvoice(fixture, partyId, {
      taxInclusive: true,
      lines: [{ description: "All-in price", quantityMilli: 1000, unitPriceMinor: 11_800 }],
    });

    expect(document.netMinor).toBe(10_000);
    expect(document.taxMinor).toBe(1_800);
    expect(document.grossMinor).toBe(11_800);
  });
});

/* ------------------------------------------------------------ acceptance 2 */

describe("2 — INR inter-state invoice", () => {
  it("charges IGST 18 and no CGST or SGST", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, {
      name: "Mumbai Traders",
      region: MAHARASHTRA,
      gstin: "27AAACX1234C1ZP",
    });

    const { document } = await postInvoice(fixture, partyId);

    expect(document.placeOfSupplyCode).toBe(MAHARASHTRA);
    expect(document.taxMinor).toBe(1_800);
    expect(document.grossMinor).toBe(11_800);

    const tb = await trialBalance(fixture);
    expect(tb["1100"]).toBe(11_800);
    expect(tb["4100"]).toBe(-10_000);
    expect(tb["2220"]).toBe(-1_800); // Output IGST
    expect(tb["2200"]).toBeUndefined();
    expect(tb["2210"]).toBeUndefined();
  });
});

/* ------------------------------------------------------------ acceptance 3 */

describe("3 — generic VAT pack", () => {
  it("charges VAT 20 with no change to the invoice code path", async () => {
    const fixture = await freshBook("GENERIC_VAT", "EUR");
    const partyId = await customer(fixture, {
      name: "Lisboa Lda",
      countryCode: "PT",
      currency: "EUR",
    });

    const { document } = await postInvoice(fixture, partyId);

    expect(document.netMinor).toBe(10_000);
    expect(document.taxMinor).toBe(2_000);
    expect(document.grossMinor).toBe(12_000);
    // A continuous series, because this pack does not reset each fiscal year.
    expect(document.documentNumber).toMatch(/^INV-\d{5}$/);

    const tb = await trialBalance(fixture, "2026-12-31");
    expect(tb["1100"]).toBe(12_000);
    expect(tb["4100"]).toBe(-10_000);
    expect(tb["2200"]).toBe(-2_000); // VAT payable
  });
});

/* ------------------------------------------------------------ acceptance 4 */

describe("4 — credit note against a posted invoice", () => {
  it("closes the open item and restores the trial balance", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const { document: invoice } = await postInvoice(fixture, partyId);

    const draftNote = await documents.creditNoteFromInvoice(
      fixture.orgId,
      USER_ID,
      invoice.id,
    );
    expect(draftNote.documentType).toBe("CREDIT_NOTE");
    expect(draftNote.originalDocumentId).toBe(invoice.id);

    const { document: note, journal } = await documents.post(
      fixture.orgId,
      USER_ID,
      draftNote.id,
    );
    expect(note.grossMinor).toBe(11_800);
    expect(note.documentNumber).toMatch(/^CRN\/2026-27\/\d{4}$/);
    expect(journal.sourceType).toBe("credit_note");

    // The mirror: AR credited, revenue and tax debited.
    const arAccount = await accountId(fixture.bookId, "1100");
    const arLine = journal.lines.find((l) => l.accountId === arAccount);
    expect(arLine?.creditMinor).toBe(11_800);

    await receipts.allocateCreditNote(fixture.orgId, USER_ID, note.id, {
      allocations: [{ documentId: invoice.id, amountMinor: 11_800 }],
    });

    const settledInvoice = await documents.get(fixture.orgId, invoice.id);
    expect(settledInvoice.openMinor).toBe(0);
    expect(settledInvoice.status).toBe("PAID");

    const settledNote = await documents.get(fixture.orgId, note.id);
    expect(settledNote.openMinor).toBe(0);
    expect(settledNote.status).toBe("PAID");

    const tb = await trialBalance(fixture);
    expect(tb["1100"]).toBe(0);
    expect(tb["4100"]).toBe(0);
    expect(tb["2200"]).toBe(0);
    expect(tb["2210"]).toBe(0);

    const report = await aging.aging(fixture.orgId, { asOf: AS_OF });
    expect(report.rows).toHaveLength(0);
    expect(report.reconciliation.balanced).toBe(true);
  });

  it("refuses to credit more than the invoice has open", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const { document: invoice } = await postInvoice(fixture, partyId);

    const draftNote = await documents.creditNoteFromInvoice(fixture.orgId, USER_ID, invoice.id);
    const { document: note } = await documents.post(fixture.orgId, USER_ID, draftNote.id);

    await expect(
      receipts.allocateCreditNote(fixture.orgId, USER_ID, note.id, {
        allocations: [{ documentId: invoice.id, amountMinor: 11_801 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ------------------------------------------------------------ acceptance 5 */

describe("5 — two receipts, partial then full", () => {
  it("moves the invoice through PARTIALLY_PAID to PAID and empties the aging", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const { document: invoice } = await postInvoice(fixture, partyId);
    const bank = await bankAccountId(fixture.bookId);

    const first = await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 5_000,
      allocations: [{ documentId: invoice.id, amountMinor: 5_000 }],
    });
    expect(first.receipt.unappliedMinor).toBe(0);
    expect(first.receipt.receiptNumber).toMatch(/^RCP\/2026-27\/\d{4}$/);

    const afterFirst = await documents.get(fixture.orgId, invoice.id);
    expect(afterFirst.status).toBe("PARTIALLY_PAID");
    expect(afterFirst.openMinor).toBe(6_800);

    // Aging still shows the remainder, and still ties to the control account.
    const midway = await aging.aging(fixture.orgId, { asOf: AS_OF });
    expect(midway.totals.totalMinor).toBe(6_800);
    expect(midway.reconciliation.balanced).toBe(true);

    const second = await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 6_800,
      autoAllocateFifo: true,
    });
    expect(second.receipt.unappliedMinor).toBe(0);

    const afterSecond = await documents.get(fixture.orgId, invoice.id);
    expect(afterSecond.status).toBe("PAID");
    expect(afterSecond.openMinor).toBe(0);

    const report = await aging.aging(fixture.orgId, { asOf: AS_OF });
    expect(report.rows).toHaveLength(0);
    expect(report.totals.totalMinor).toBe(0);

    const tb = await trialBalance(fixture);
    expect(tb["1100"]).toBe(0); // AR control back to zero for this customer
    expect(tb["1020"]).toBe(11_800); // and the cash is in the bank
  });

  it("refuses to allocate more than the invoice has open", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const { document: invoice } = await postInvoice(fixture, partyId);
    const bank = await bankAccountId(fixture.bookId);

    const { receipt } = await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 20_000,
    });

    await expect(
      receipts.allocate(fixture.orgId, USER_ID, receipt.id, {
        allocations: [{ documentId: invoice.id, amountMinor: 11_801 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // …and never more than the receipt itself is holding.
    const { receipt: small } = await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 100,
    });
    await expect(
      receipts.allocate(fixture.orgId, USER_ID, small.id, {
        allocations: [{ documentId: invoice.id, amountMinor: 500 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("reverses a receipt, unwinds its allocations and reopens the invoice", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const { document: invoice } = await postInvoice(fixture, partyId);
    const bank = await bankAccountId(fixture.bookId);

    const { receipt } = await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 11_800,
      autoAllocateFifo: true,
    });
    expect((await documents.get(fixture.orgId, invoice.id)).status).toBe("PAID");

    const { receipt: reversed, reversalJournal } = await receipts.reverseReceipt(
      fixture.orgId,
      USER_ID,
      receipt.id,
    );
    expect(reversed.status).toBe("REVERSED");
    expect(reversed.allocations).toHaveLength(0);
    expect(reversalJournal?.reversesJournalId).toBe(receipt.postedJournalId);

    const reopened = await documents.get(fixture.orgId, invoice.id);
    expect(reopened.status).toBe("POSTED");
    expect(reopened.openMinor).toBe(11_800);

    const tb = await trialBalance(fixture);
    expect(tb["1020"]).toBe(0);
    expect(tb["1100"]).toBe(11_800);

    // Reversing twice is a no-op, not a second mirror journal.
    const again = await receipts.reverseReceipt(fixture.orgId, USER_ID, receipt.id);
    expect(again.reversalJournal?.id).toBe(reversalJournal?.id);
  });
});

/* ------------------------------------------------------------ acceptance 6 */

describe("6 — double-click Post", () => {
  it("produces exactly one journal when posted twice in a row", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const draft = await documents.createInvoice(
      fixture.orgId,
      USER_ID,
      invoiceInput(partyId),
    );

    const first = await documents.post(fixture.orgId, USER_ID, draft.id);
    const second = await documents.post(fixture.orgId, USER_ID, draft.id);

    expect(second.journal.id).toBe(first.journal.id);
    expect(second.journal.replayed).toBe(true);
    expect(second.document.documentNumber).toBe(first.document.documentNumber);

    const journals = await db
      .select({ id: glJournals.id })
      .from(glJournals)
      .where(and(eq(glJournals.bookId, fixture.bookId), eq(glJournals.sourceId, draft.id)));
    expect(journals).toHaveLength(1);

    const tb = await trialBalance(fixture);
    expect(tb["1100"]).toBe(11_800);
  });

  it("produces exactly one journal when two posts race", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const draft = await documents.createInvoice(
      fixture.orgId,
      USER_ID,
      invoiceInput(partyId),
    );

    const [a, b] = await Promise.all([
      documents.post(fixture.orgId, USER_ID, draft.id),
      documents.post(fixture.orgId, USER_ID, draft.id),
    ]);

    expect(a.journal.id).toBe(b.journal.id);

    const journals = await db
      .select({ id: glJournals.id })
      .from(glJournals)
      .where(and(eq(glJournals.bookId, fixture.bookId), eq(glJournals.sourceId, draft.id)));
    expect(journals).toHaveLength(1);

    // And the tax rows were frozen once, not twice.
    const frozen = await db
      .select({ id: taxDocumentLines.id })
      .from(taxDocumentLines)
      .where(eq(taxDocumentLines.documentId, draft.id));
    expect(frozen).toHaveLength(2); // CGST + SGST
  });
});

/* ------------------------------------------------------------ acceptance 7 */

describe("7 — editing a posted document", () => {
  it("rejects the edit with a 409 and leaves the document untouched", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const { document } = await postInvoice(fixture, partyId);

    await expect(
      documents.updateDraft(fixture.orgId, document.id, { memo: "second thoughts" }),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(documents.deleteDraft(fixture.orgId, document.id)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const unchanged = await documents.get(fixture.orgId, document.id);
    expect(unchanged.memo).toBeNull();
    expect(unchanged.grossMinor).toBe(11_800);
  });

  it("allows every edit while the document is still a draft", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const draft = await documents.createInvoice(fixture.orgId, USER_ID, invoiceInput(partyId));

    const edited = await documents.updateDraft(fixture.orgId, draft.id, {
      memo: "revised scope",
      lines: [
        { description: "Consulting services", quantityMilli: 2000, unitPriceMinor: 10_000 },
      ],
    });
    expect(edited.memo).toBe("revised scope");
    expect(edited.netMinor).toBe(20_000);
    expect(edited.lines).toHaveLength(1);

    const { document } = await documents.post(fixture.orgId, USER_ID, draft.id);
    expect(document.grossMinor).toBe(23_600);
  });
});

/* ------------------------------------------------------------ acceptance 8 */

describe("8 — a USD invoice on an INR entity", () => {
  it("stores the transaction in USD and the functional amounts in INR at the snapshot rate", async () => {
    const fixture = await freshBook("IN", "INR");
    // The book only trades in currencies it has enabled (PRD 11 M4).
    await db
      .insert(glBookCurrencies)
      .values({ orgId: fixture.orgId, bookId: fixture.bookId, currencyCode: "USD", isBase: false })
      .onConflictDoNothing();
    const partyId = await customer(fixture, {
      name: "Delaware Inc",
      countryCode: "US",
      currency: "USD",
      region: null,
    });

    const draft = await documents.createInvoice(fixture.orgId, USER_ID, {
      ...invoiceInput(partyId),
      currency: "USD",
      fxRate: "83.25",
      supplyNature: "export",
    });
    expect(draft.currency).toBe("USD");
    expect(Number(draft.fxRate)).toBe(83.25);

    const { document, journal } = await documents.post(fixture.orgId, USER_ID, draft.id);

    // Export under LUT is zero-rated, so gross is the net.
    expect(document.grossMinor).toBe(10_000);
    expect(document.functionalGrossMinor).toBe(832_500);

    const arAccount = await accountId(fixture.bookId, "1100");
    const arLine = journal.lines.find((l) => l.accountId === arAccount);
    expect(arLine).toBeDefined();
    expect(arLine!.debitMinor).toBe(832_500);
    expect(arLine!.txnCurrency).toBe("USD");
    expect(arLine!.txnAmountMinor).toBe(10_000);
    expect(Number(arLine!.fxRate)).toBe(83.25);
    expect(arLine!.functionalCurrency).toBe("INR");

    // The books balance in INR; the trial balance never sees a dollar.
    const tb = await trialBalance(fixture);
    expect(tb["1100"]).toBe(832_500);
    expect(tb["4100"]).toBe(-832_500);
  });

  it("posts the FX allocation residue to the rounding account so the journal balances", async () => {
    const fixture = await freshBook("IN", "INR");
    // The book only trades in currencies it has enabled (PRD 11 M4).
    await db
      .insert(glBookCurrencies)
      .values({ orgId: fixture.orgId, bookId: fixture.bookId, currencyCode: "USD", isBase: false })
      .onConflictDoNothing();
    const partyId = await customer(fixture, {
      name: "Delaware Inc",
      countryCode: "US",
      currency: "USD",
    });

    // Three lines of 33.33 convert to 277496 paise each (832488 in total), while
    // the 99.99 document total converts to 832487. The paisa has to go somewhere.
    const draft = await documents.createInvoice(fixture.orgId, USER_ID, {
      partyId,
      issueDate: AS_OF,
      currency: "USD",
      fxRate: "83.257",
      supplyNature: "export",
      lines: [1, 2, 3].map((n) => ({
        description: `Milestone ${n}`,
        quantityMilli: 1000,
        unitPriceMinor: 3_333,
      })),
    });

    const { journal } = await documents.post(fixture.orgId, USER_ID, draft.id);

    expect(journal.totalDebitMinor).toBe(journal.totalCreditMinor);

    const roundingAccount = await accountId(fixture.bookId, "5990");
    const roundingLine = journal.lines.find((l) => l.accountId === roundingAccount);
    expect(roundingLine).toBeDefined();
    expect(roundingLine!.debitMinor).toBe(1);
    expect(roundingLine!.txnCurrency).toBe("INR");
  });

  it("takes the rate from gl_fx_rates when the caller does not supply one", async () => {
    const fixture = await freshBook("IN", "INR");
    // The book only trades in currencies it has enabled (PRD 11 M4).
    await db
      .insert(glBookCurrencies)
      .values({ orgId: fixture.orgId, bookId: fixture.bookId, currencyCode: "USD", isBase: false })
      .onConflictDoNothing();
    const partyId = await customer(fixture, {
      name: "Delaware Inc",
      countryCode: "US",
      currency: "USD",
    });
    await db.insert(glFxRates).values({
      orgId: fixture.orgId,
      bookId: fixture.bookId,
      fromCode: "USD",
      toCode: "INR",
      rateDate: "2026-08-01",
      rate: "84.1000000000",
    });

    const draft = await documents.createInvoice(fixture.orgId, USER_ID, {
      ...invoiceInput(partyId),
      currency: "USD",
      supplyNature: "export",
    });
    expect(Number(draft.fxRate)).toBe(84.1);

    const { document } = await documents.post(fixture.orgId, USER_ID, draft.id);
    expect(document.functionalGrossMinor).toBe(841_000);
  });

  it("refuses a foreign-currency document with no rate on file", async () => {
    const fixture = await freshBook("IN", "INR");
    // The book only trades in currencies it has enabled (PRD 11 M4).
    await db
      .insert(glBookCurrencies)
      .values({ orgId: fixture.orgId, bookId: fixture.bookId, currencyCode: "USD", isBase: false })
      .onConflictDoNothing();
    const partyId = await customer(fixture, {
      name: "Delaware Inc",
      countryCode: "US",
      currency: "USD",
    });

    await expect(
      documents.createInvoice(fixture.orgId, USER_ID, {
        ...invoiceInput(partyId),
        currency: "USD",
        supplyNature: "export",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* ------------------------------------------------------------ acceptance 9 */

describe("9 — AR aging", () => {
  it("puts a 45-day-old invoice in the 31-60 bucket", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const dueDate = addDays(AS_OF, -45);

    await postInvoice(fixture, partyId, { issueDate: dueDate, dueDate });

    const report = await aging.aging(fixture.orgId, { asOf: AS_OF, basis: "due" });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].buckets).toEqual({
      days0to30: 0,
      days31to60: 11_800,
      days61to90: 0,
      days91Plus: 0,
    });
    expect(report.rows[0].totalMinor).toBe(11_800);
  });

  it("fills every bucket by age and ties the total to the AR control account", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });

    // All four still fall inside the fiscal year opened at enable time
    // (1 Apr 2026 – 31 Mar 2027); posting outside it is its own test below.
    const ages = [10, 45, 75, 120];
    for (const age of ages) {
      const date = addDays(AS_OF, -age);
      await postInvoice(fixture, partyId, { issueDate: date, dueDate: date });
    }

    const report = await aging.aging(fixture.orgId, { asOf: AS_OF, basis: "due" });
    expect(report.rows[0].buckets).toEqual({
      days0to30: 11_800,
      days31to60: 11_800,
      days61to90: 11_800,
      days91Plus: 11_800,
    });

    expect(report.totals.totalMinor).toBe(47_200);
    expect(report.reconciliation.arControlBalanceMinor).toBe(47_200);
    expect(report.reconciliation.differenceMinor).toBe(0);
    expect(report.reconciliation.balanced).toBe(true);
  });

  it("ages from the issue date when asked to", async () => {
    const fixture = await freshBook("IN", "INR");
    // Issued 45 days ago on 90-day terms: overdue on issue basis, current on due.
    const partyId = await customer(fixture, { region: KARNATAKA, paymentTermsDays: 90 });
    const issueDate = addDays(AS_OF, -45);
    await postInvoice(fixture, partyId, { issueDate });

    const byDue = await aging.aging(fixture.orgId, { asOf: AS_OF, basis: "due" });
    expect(byDue.rows[0].buckets.days0to30).toBe(11_800);

    const byIssue = await aging.aging(fixture.orgId, { asOf: AS_OF, basis: "issue" });
    expect(byIssue.rows[0].buckets.days31to60).toBe(11_800);
  });

  it("reports the position as it stood, not as it stands now", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const issueDate = addDays(AS_OF, -60);
    const { document: invoice } = await postInvoice(fixture, partyId, {
      issueDate,
      dueDate: issueDate,
    });
    const bank = await bankAccountId(fixture.bookId);

    await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 11_800,
      allocations: [{ documentId: invoice.id, amountMinor: 11_800 }],
    });

    // Today the customer owes nothing…
    const today = await aging.aging(fixture.orgId, { asOf: AS_OF });
    expect(today.totals.totalMinor).toBe(0);
    expect(today.reconciliation.balanced).toBe(true);

    // …but a week before the receipt landed, they owed the lot.
    const before = addDays(AS_OF, -7);
    const earlier = await aging.aging(fixture.orgId, { asOf: before });
    expect(earlier.totals.totalMinor).toBe(11_800);
    expect(earlier.reconciliation.balanced).toBe(true);
  });
});

/* ------------------------------------------------- the standing invariant */

describe("invariant — AR control equals the sum of open items", () => {
  it("holds across invoices, credit notes, partial receipts and unapplied cash", async () => {
    const fixture = await freshBook("IN", "INR");
    const alpha = await customer(fixture, { name: "Alpha Ltd", region: KARNATAKA });
    const beta = await customer(fixture, { name: "Beta LLP", region: MAHARASHTRA });
    const bank = await bankAccountId(fixture.bookId);

    const { document: alphaOne } = await postInvoice(fixture, alpha, {
      issueDate: addDays(AS_OF, -50),
      dueDate: addDays(AS_OF, -50),
    });
    const { document: alphaTwo } = await postInvoice(fixture, alpha, {
      lines: [{ description: "Retainer", quantityMilli: 3000, unitPriceMinor: 10_000 }],
    });
    await postInvoice(fixture, beta, {
      lines: [{ description: "Licence", quantityMilli: 1000, unitPriceMinor: 77_777 }],
    });

    // A credit note, only partly applied.
    const draftNote = await documents.creditNoteFromInvoice(fixture.orgId, USER_ID, alphaTwo.id, {
      lines: [{ description: "Goodwill discount", quantityMilli: 1000, unitPriceMinor: 5_000 }],
    });
    const { document: note } = await documents.post(fixture.orgId, USER_ID, draftNote.id);
    await receipts.allocateCreditNote(fixture.orgId, USER_ID, note.id, {
      allocations: [{ documentId: alphaTwo.id, amountMinor: 3_000 }],
    });

    // A receipt that settles part of one invoice.
    await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId: alpha,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 4_000,
      allocations: [{ documentId: alphaOne.id, amountMinor: 4_000 }],
    });

    // …and a customer advance nobody has applied yet.
    await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId: beta,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 25_000,
    });

    const report = await aging.aging(fixture.orgId, { asOf: AS_OF });
    const controlBalance = await aging.arControlBalance(fixture.orgId, fixture.bookId, AS_OF);
    const tb = await trialBalance(fixture, AS_OF);

    expect(report.reconciliation.arControlBalanceMinor).toBe(controlBalance);
    expect(tb["1100"]).toBe(controlBalance);
    expect(report.totals.functionalTotalMinor).toBe(controlBalance);
    expect(report.reconciliation.differenceMinor).toBe(0);
    expect(report.reconciliation.balanced).toBe(true);

    // The same equality one document at a time, so a failure names the culprit.
    const items = await aging.openItems(
      fixture.orgId,
      fixture.bookId,
      fixture.baseCurrency,
      AS_OF,
      "due",
    );
    expect(items.reduce((a, i) => a + i.functionalOpenMinor, 0)).toBe(controlBalance);
    expect(items.some((i) => i.kind === "unapplied_receipt")).toBe(true);
    expect(items.some((i) => i.kind === "credit_note")).toBe(true);
  });
});

/* ---------------------------------------------------------------- preview */

describe("tax preview", () => {
  it("returns the split without posting anything", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const draft = await documents.createInvoice(fixture.orgId, USER_ID, invoiceInput(partyId));

    const preview = await documents.previewTax(fixture.orgId, draft.id);

    expect(preview.netMinor).toBe(10_000);
    expect(preview.taxMinor).toBe(1_800);
    expect(preview.grossMinor).toBe(11_800);
    expect(preview.errors).toHaveLength(0);
    expect(preview.lines[0].components.map((c) => c.component).sort()).toEqual(["CGST", "SGST"]);
    expect(preview.lines[0].components.every((c) => c.accountId !== null)).toBe(true);

    // Nothing was written: no journal, no frozen rows, still a draft.
    const still = await documents.get(fixture.orgId, draft.id);
    expect(still.status).toBe("DRAFT");
    expect(still.postedJournalId).toBeNull();
    expect(still.documentNumber).toBeNull();

    const frozen = await db
      .select({ id: taxDocumentLines.id })
      .from(taxDocumentLines)
      .where(eq(taxDocumentLines.documentId, draft.id));
    expect(frozen).toHaveLength(0);
  });

  it("surfaces a missing seller registration as an error rather than zero tax", async () => {
    const orgId = await seedOrg();
    const book = await books.enable(orgId, USER_ID, {
      countryCode: "IN",
      packCode: "IN",
      baseCurrency: "INR",
      openFrom: AS_OF,
    });
    await tax.seedPack(orgId, book.id, "IN");
    // Deliberately no seller GSTIN.

    const fixture: Fixture = { orgId, bookId: book.id, baseCurrency: "INR" };
    const partyId = await customer(fixture, { region: KARNATAKA });
    const draft = await documents.createInvoice(orgId, USER_ID, invoiceInput(partyId));

    const preview = await documents.previewTax(orgId, draft.id);
    expect(preview.errors.map((e) => e.code)).toContain("SELLER_NOT_REGISTERED");

    await expect(documents.post(orgId, USER_ID, draft.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // The failed post consumed nothing and wrote nothing.
    const untouched = await documents.get(orgId, draft.id);
    expect(untouched.status).toBe("DRAFT");
    expect(untouched.documentNumber).toBeNull();
  });
});

/* ----------------------------------------------------------------- parties */

describe("party master", () => {
  it("maps a CRM company to exactly one customer, however often it is resolved", async () => {
    const fixture = await freshBook("IN", "INR");
    const ref = { system: "crm", id: "company-4711" };
    const fields = {
      displayName: "Acme Industries",
      countryCode: "IN",
      defaultCurrency: "INR",
      billingRegion: KARNATAKA,
    };

    const first = await parties.resolveOrCreateByExternalRef(
      fixture.orgId,
      fixture.bookId,
      ref,
      fields,
    );
    const second = await parties.resolveOrCreateByExternalRef(
      fixture.orgId,
      fixture.bookId,
      ref,
      fields,
    );

    expect(second.id).toBe(first.id);
    expect(first.externalRefs).toEqual([ref]);

    const page = await parties.list(fixture.orgId, {});
    expect(page.items.filter((p) => p.displayName === "Acme Industries")).toHaveLength(1);
  });

  it("resolves the same company concurrently to one party, not two", async () => {
    const fixture = await freshBook("IN", "INR");
    const ref = { system: "crm", id: "company-race" };
    const fields = {
      displayName: "Race Condition Ltd",
      countryCode: "IN",
      defaultCurrency: "INR",
    };

    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        parties.resolveOrCreateByExternalRef(fixture.orgId, fixture.bookId, ref, fields),
      ),
    );

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it("widens a vendor to both rather than creating a second identity", async () => {
    const fixture = await freshBook("IN", "INR");
    const ref = { system: "crm", id: "company-both" };

    const vendor = await parties.resolveOrCreateByExternalRef(fixture.orgId, fixture.bookId, ref, {
      displayName: "Supplier and Customer Pvt Ltd",
      countryCode: "IN",
      defaultCurrency: "INR",
      role: "vendor",
    });
    expect(vendor.role).toBe("vendor");

    const asCustomer = await parties.resolveOrCreateByExternalRef(
      fixture.orgId,
      fixture.bookId,
      ref,
      {
        displayName: "Supplier and Customer Pvt Ltd",
        countryCode: "IN",
        defaultCurrency: "INR",
        role: "customer",
      },
    );
    expect(asCustomer.id).toBe(vendor.id);
    expect(asCustomer.role).toBe("both");
  });

  it("derives the Indian state from a GSTIN so determination has a region", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: null });

    const registration = await parties.addRegistration(fixture.orgId, partyId, {
      regime: "GST_IN",
      number: "27aaacx1234c1zp",
      countryCode: "IN",
    });

    expect(registration.number).toBe("27AAACX1234C1ZP");
    expect(registration.region).toBe(MAHARASHTRA);
    expect(registration.isPrimary).toBe(true);
  });

  it("soft-deletes and keeps deleted parties out of every read", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { name: "Gone Ltd", region: KARNATAKA });

    await parties.remove(fixture.orgId, partyId);

    await expect(parties.get(fixture.orgId, partyId)).rejects.toBeInstanceOf(NotFoundException);
    const page = await parties.list(fixture.orgId, { includeInactive: true });
    expect(page.items.some((p) => p.id === partyId)).toBe(false);
  });
});

/* --------------------------------------------------------- tenant isolation */

describe("tenant isolation", () => {
  it("returns 404, never 403, for another organisation's document", async () => {
    const mine = await freshBook("IN", "INR");
    const theirs = await freshBook("IN", "INR");
    const partyId = await customer(theirs, { region: KARNATAKA });
    const { document } = await postInvoice(theirs, partyId);

    await expect(documents.get(mine.orgId, document.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(parties.get(mine.orgId, partyId)).rejects.toBeInstanceOf(NotFoundException);

    // And the neighbour's ledger is untouched by ours.
    const mineTb = await trialBalance(mine);
    expect(mineTb["1100"]).toBeUndefined();
  });

  it("refuses to settle one customer's invoice with another customer's receipt", async () => {
    const fixture = await freshBook("IN", "INR");
    const alpha = await customer(fixture, { name: "Alpha Ltd", region: KARNATAKA });
    const beta = await customer(fixture, { name: "Beta LLP", region: KARNATAKA });
    const bank = await bankAccountId(fixture.bookId);

    const { document: alphaInvoice } = await postInvoice(fixture, alpha);
    const { receipt } = await receipts.postReceipt(fixture.orgId, USER_ID, {
      partyId: beta,
      receiptDate: AS_OF,
      depositAccountId: bank,
      amountMinor: 11_800,
    });

    await expect(
      receipts.allocate(fixture.orgId, USER_ID, receipt.id, {
        allocations: [{ documentId: alphaInvoice.id, amountMinor: 11_800 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

/* -------------------------------------------------------------- draft state */

describe("drafts", () => {
  it("keeps a draft out of the ledger and out of the aging", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    await documents.createInvoice(fixture.orgId, USER_ID, invoiceInput(partyId));

    const tb = await trialBalance(fixture);
    expect(tb["1100"]).toBeUndefined();

    const report = await aging.aging(fixture.orgId, { asOf: AS_OF });
    expect(report.totals.totalMinor).toBe(0);
  });

  it("soft-deletes a draft and stops resolving it", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    const draft = await documents.createInvoice(fixture.orgId, USER_ID, invoiceInput(partyId));

    await documents.deleteDraft(fixture.orgId, draft.id);
    await expect(documents.get(fixture.orgId, draft.id)).rejects.toBeInstanceOf(NotFoundException);

    const [row] = await db
      .select({ deletedAt: arDocuments.deletedAt })
      .from(arDocuments)
      .where(eq(arDocuments.id, draft.id));
    expect(row.deletedAt).not.toBeNull();
  });

  it("refuses to post into a period no fiscal year covers", async () => {
    const fixture = await freshBook("IN", "INR");
    const partyId = await customer(fixture, { region: KARNATAKA });
    // 2030 is well beyond the year that was opened at enable time.
    const draft = await documents.createInvoice(fixture.orgId, USER_ID, {
      ...invoiceInput(partyId),
      issueDate: "2030-06-15",
    });

    await expect(documents.post(fixture.orgId, USER_ID, draft.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
