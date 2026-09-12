/**
 * Purchases / AP acceptance suite — the hard gate from `03-prd-purchases-ap.md`.
 *
 * Every acceptance test in that PRD is here, plus the duplicate-vendor-number
 * case (M3) and blocked input tax (M8). These run against a real Postgres
 * because half of what is being proven — the partial unique index behind the
 * duplicate check, the `ck_ap_payments_net` CHECK, idempotent posting — does
 * not exist in a mock.
 *
 * Services are constructed directly rather than through Nest DI; booting
 * `AppModule` would take longer than the suite and prove nothing extra.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import { ConflictException } from "@nestjs/common";
import * as schema from "../../../db/schema";
import {
  apAllocations,
  apDocuments,
  apPayments,
  apWithholding,
  glAccounts,
  glJournals,
  glParties,
  organizationMembers,
  organizations,
  taxCodes,
  taxDocumentLines,
  taxRates,
  taxRegistrations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService } from "../kernel/sequence.service";
import { PackRegistry } from "../packs/pack.registry";
import { TaxEngineRegistry } from "../tax/tax-engine.registry";
import { TaxService } from "../tax/tax.service";
import { ApAgingService } from "./ap-aging.service";
import { ApDocumentsService } from "./ap-documents.service";
import { ApPaymentsService } from "./ap-payments.service";
import { WithholdingEngineRegistry } from "./withholding/withholding.registry";
import { createApDocumentSchema } from "./dto/ap-documents.schemas";
import { postApPaymentSchema } from "./dto/ap-payments.schemas";
import { apAgingQuerySchema } from "./dto/ap-aging.schemas";

const ISSUE_DATE = "2026-08-25";
const AS_OF = "2026-08-25";
const YEAR_END = "2027-03-31";
const USER_ID = null;

/** Karnataka is 29, Maharashtra 27 — the intra/inter-state switch. */
const KARNATAKA = "29";
const MAHARASHTRA = "27";
const SELLER_GSTIN = "29AABCU9603R1ZM";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;
let taxService: TaxService;
let documents: ApDocumentsService;
let payments: ApPaymentsService;
let aging: ApAgingService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/* ------------------------------------------------------------- fixtures */

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

interface Book {
  orgId: string;
  bookId: string;
  baseCurrency: string;
}

/** An Indian book with GST seeded and a Karnataka GSTIN on file. */
async function indiaBook(): Promise<Book> {
  const orgId = await seedOrg();
  const book = await books.enable(orgId, USER_ID, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    openFrom: "2026-04-01",
  });
  await taxService.seedPack(orgId, book.id, "IN");
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
  return { orgId, bookId: book.id, baseCurrency: "INR" };
}

/** A euro book on the generic VAT pack, with the standard rate edited to 19%. */
async function genericVatBook(rateBp = 1900): Promise<Book> {
  const orgId = await seedOrg();
  const book = await books.enable(orgId, USER_ID, {
    countryCode: "PT",
    packCode: "GENERIC_VAT",
    baseCurrency: "EUR",
    openFrom: "2026-01-01",
  });
  await taxService.seedPack(orgId, book.id, "GENERIC_VAT");

  // A tenant edits the rate row rather than the engine — that is the whole
  // point of dated rates, so the fixture does it the way a tenant would.
  const [standard] = await db
    .select({ id: taxCodes.id })
    .from(taxCodes)
    .where(and(eq(taxCodes.bookId, book.id), eq(taxCodes.code, "VAT_STD")))
    .limit(1);
  await db.update(taxRates).set({ rateBp }).where(eq(taxRates.taxCodeId, standard.id));

  return { orgId, bookId: book.id, baseCurrency: "EUR" };
}

interface VendorOptions {
  name?: string;
  region?: string;
  countryCode?: string;
  gstin?: string | null;
  withholdingCode?: string | null;
}

async function createVendor(book: Book, options: VendorOptions = {}): Promise<string> {
  const countryCode = options.countryCode ?? "IN";
  const [vendor] = await db
    .insert(glParties)
    .values({
      orgId: book.orgId,
      bookId: book.bookId,
      role: "vendor",
      displayName: options.name ?? "Acme Supplies",
      countryCode,
      defaultCurrency: book.baseCurrency,
      billingCountryCode: countryCode,
      billingRegion: options.region ?? null,
      withholdingCode: options.withholdingCode ?? null,
    })
    .returning({ id: glParties.id });

  if (options.gstin) {
    await db.insert(taxRegistrations).values({
      orgId: book.orgId,
      ownerType: "party",
      partyId: vendor.id,
      regime: "GST_IN",
      number: options.gstin,
      region: options.gstin.slice(0, 2),
      countryCode,
    });
  }
  return vendor.id;
}

/** Trial balance as `account code -> signed balance`, for terse assertions. */
async function trialBalance(book: Book, asOf = YEAR_END): Promise<Record<string, number>> {
  const rows = await ledger.trialBalance(book.orgId, book.bookId, asOf);
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

interface BillOptions {
  documentType?: "BILL" | "DEBIT_NOTE";
  unitPriceMinor?: number;
  quantityMilli?: number;
  taxCategory?: "standard" | "zero" | "reverse_charge";
  supplyNature?: "domestic_b2b" | "reverse_charge";
  blockedInputTax?: boolean;
  issueDate?: string;
  dueDate?: string;
  vendorDocumentNumber?: string;
  originalDocumentId?: string;
  currency?: string;
}

async function makeDocument(book: Book, partyId: string, options: BillOptions = {}) {
  const payload = createApDocumentSchema.parse({
    bookId: book.bookId,
    documentType: options.documentType ?? "BILL",
    partyId,
    vendorDocumentNumber: options.vendorDocumentNumber ?? null,
    issueDate: options.issueDate ?? ISSUE_DATE,
    dueDate: options.dueDate ?? null,
    currency: options.currency ?? book.baseCurrency,
    supplyNature: options.supplyNature,
    blockedInputTax: options.blockedInputTax ?? false,
    originalDocumentId: options.originalDocumentId ?? null,
    lines: [
      {
        description: "Consulting",
        quantityMilli: options.quantityMilli ?? 1000,
        unitPriceMinor: options.unitPriceMinor ?? 10_000,
        taxCategory: options.taxCategory ?? "standard",
        commodityCode: "998313",
      },
    ],
  });
  return documents.create(book.orgId, USER_ID, payload);
}

async function makeAndPost(book: Book, partyId: string, options: BillOptions = {}) {
  const created = await makeDocument(book, partyId, options);
  return documents.post(book.orgId, USER_ID, created.id);
}

/* --------------------------------------------------------------- harness */

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for the AP acceptance suite");
  client = postgres(url, { prepare: false, max: 5 });
  db = drizzle(client, { schema }) as unknown as Db;

  const packs = new PackRegistry();
  const sequences = new SequenceService(db);
  books = new BooksService(db, packs);
  ledger = new LedgerService(db, sequences, packs);
  taxService = new TaxService(db, new TaxEngineRegistry());
  documents = new ApDocumentsService(db, books, ledger, sequences, taxService, packs);
  payments = new ApPaymentsService(
    db,
    books,
    ledger,
    sequences,
    taxService,
    packs,
    new WithholdingEngineRegistry(),
  );
  aging = new ApAgingService(db, books);
});

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    // AP rows are unwound explicitly first: `posted_journal_id` and
    // `party_id` are ON DELETE RESTRICT, so a bare org cascade could try to
    // remove a journal a document still points at.
    await db.delete(apAllocations).where(inArray(apAllocations.orgId, createdOrgIds));
    await db.delete(apWithholding).where(inArray(apWithholding.orgId, createdOrgIds));
    await db.delete(apPayments).where(inArray(apPayments.orgId, createdOrgIds));
    await db.delete(apDocuments).where(inArray(apDocuments.orgId, createdOrgIds));
    await db.delete(taxDocumentLines).where(inArray(taxDocumentLines.orgId, createdOrgIds));
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client?.end({ timeout: 5 });
});

/* ------------------------------------------------------------ acceptance 1 */

describe("1 — a standard 18% intra-state India bill", () => {
  it("debits expense 100, input CGST 9 and input SGST 9, and credits AP 118", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });

    const posted = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });

    expect(posted.document.status).toBe("POSTED");
    expect(posted.document.netMinor).toBe(10_000);
    expect(posted.document.taxMinor).toBe(1_800);
    expect(posted.document.grossMinor).toBe(11_800);
    expect(posted.document.documentNumber).toMatch(/^BILL\/2026-27\/\d+$/);
    expect(posted.document.gstrPeriod).toBe("2026-08");

    const balances = await trialBalance(book);
    expect(balances["5300"]).toBe(10_000); // operating expenses
    expect(balances["1200"]).toBe(900); // input CGST
    expect(balances["1210"]).toBe(900); // input SGST
    expect(balances["2100"]).toBe(-11_800); // accounts payable, a credit
    expect(balances["1220"]).toBeUndefined(); // never IGST on an intra-state supply
  });

  it("splits to IGST when the vendor is in another state", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, {
      name: "Mumbai Traders",
      region: MAHARASHTRA,
      gstin: "27AAACX1234A1Z5",
    });

    const posted = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });
    expect(posted.document.taxMinor).toBe(1_800);

    const balances = await trialBalance(book);
    expect(balances["1220"]).toBe(1_800); // input IGST
    expect(balances["1200"]).toBeUndefined();
  });

  it("previews the same numbers without writing anything", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeDocument(book, vendor, { unitPriceMinor: 10_000 });

    const preview = await documents.previewTax(book.orgId, bill.id);
    expect(preview.netMinor).toBe(10_000);
    expect(preview.taxMinor).toBe(1_800);
    expect(preview.grossMinor).toBe(11_800);
    expect(preview.lines[0].components.map((c) => c.component).sort()).toEqual(["CGST", "SGST"]);
    expect(preview.errors).toEqual([]);

    // Nothing persisted: still a draft with zeroed totals and no journal.
    const reloaded = await documents.get(book.orgId, bill.id);
    expect(reloaded.status).toBe("DRAFT");
    expect(reloaded.grossMinor).toBe(0);
    expect(reloaded.postedJournalId).toBeNull();
  });
});

/* ------------------------------------------------------------ acceptance 2 */

describe("2 — a reverse-charge bill posts both legs", () => {
  it("nets GST to zero on the supply and leaves AP holding only the net", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, {
      name: "Goods Transport Agency",
      region: KARNATAKA,
      gstin: "29AAACX9999A1Z5",
    });

    const posted = await makeAndPost(book, vendor, {
      unitPriceMinor: 10_000,
      taxCategory: "reverse_charge",
      supplyNature: "reverse_charge",
    });

    // The vendor charges nothing, so accounts payable carries the net only…
    expect(posted.document.netMinor).toBe(10_000);
    expect(posted.document.taxMinor).toBe(0);
    expect(posted.document.grossMinor).toBe(10_000);
    // …while the buyer self-assesses on both sides.
    expect(posted.selfAssessedTaxMinor).toBe(1_800);

    const balances = await trialBalance(book);
    expect(balances["5300"]).toBe(10_000);
    expect(balances["2100"]).toBe(-10_000);

    expect(balances["1200"]).toBe(900); // input CGST claimed
    expect(balances["2200"]).toBe(-900); // output CGST owed
    expect(balances["1210"]).toBe(900);
    expect(balances["2210"]).toBe(-900);

    const gstAccounts = ["1200", "1210", "1220", "1230", "1240", "2200", "2210", "2220", "2230", "2240"];
    const netGst = gstAccounts.reduce((total, code) => total + (balances[code] ?? 0), 0);
    expect(netGst).toBe(0);

    const journal = await ledger.loadJournal(book.orgId, posted.journalId);
    expect(journal!.totalDebitMinor).toBe(journal!.totalCreditMinor);
    expect(journal!.lines).toHaveLength(6);
  });

  it("records both roles on the frozen tax lines", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX9999A1Z5" });
    const posted = await makeAndPost(book, vendor, {
      unitPriceMinor: 10_000,
      taxCategory: "reverse_charge",
      supplyNature: "reverse_charge",
    });

    const frozen = await db
      .select({ glRole: taxDocumentLines.glRole, taxMinor: taxDocumentLines.taxMinor })
      .from(taxDocumentLines)
      .where(eq(taxDocumentLines.documentId, posted.document.id));

    const byRole = new Map<string, number>();
    for (const row of frozen) byRole.set(row.glRole, (byRole.get(row.glRole) ?? 0) + row.taxMinor);
    expect(byRole.get("reverse_charge_input")).toBe(1_800);
    expect(byRole.get("reverse_charge_output")).toBe(1_800);
  });
});

/* ------------------------------------------------------------ acceptance 3 */

describe("3 — a generic VAT book at 19%", () => {
  it("debits input VAT and credits AP with net plus VAT", async () => {
    const book = await genericVatBook(1900);
    const vendor = await createVendor(book, {
      name: "Lisboa Serviços",
      countryCode: "PT",
    });

    const posted = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });

    expect(posted.document.netMinor).toBe(10_000);
    expect(posted.document.taxMinor).toBe(1_900);
    expect(posted.document.grossMinor).toBe(11_900);
    // The generic pack runs a continuous series, not India's annual reset.
    expect(posted.document.documentNumber).toMatch(/^BILL-\d+$/);

    const balances = await trialBalance(book, "2026-12-31");
    expect(balances["5300"]).toBe(10_000);
    expect(balances["1200"]).toBe(1_900); // VAT recoverable
    expect(balances["2100"]).toBe(-11_900);
  });
});

/* ------------------------------------------------------------ acceptance 4 */

describe("4 — a payment in full", () => {
  it("clears the bill and credits the bank with the gross", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });
    const bank = await accountId(book.bookId, "1020");

    const result = await payments.postPayment(
      book.orgId,
      USER_ID,
      postApPaymentSchema.parse({
        bookId: book.bookId,
        partyId: vendor,
        paymentDate: ISSUE_DATE,
        paymentAccountId: bank,
        allocations: [{ documentId: bill.document.id, amountMinor: 11_800 }],
      }),
    );

    expect(result.payment.grossMinor).toBe(11_800);
    expect(result.payment.withheldMinor).toBe(0);
    expect(result.payment.netPaidMinor).toBe(11_800);
    expect(result.payment.unappliedMinor).toBe(0);

    const settled = await documents.get(book.orgId, bill.document.id);
    expect(settled.status).toBe("PAID");
    expect(settled.openMinor).toBe(0);

    const balances = await trialBalance(book);
    expect(balances["2100"]).toBe(0); // accounts payable is flat
    expect(balances["1020"]).toBe(-11_800); // the bank paid out the gross
    expect(balances["2300"]).toBeUndefined(); // no withholding line at all
  });

  it("moves the bill to PARTIALLY_PAID on a part payment, and back on a reversal", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });
    const bank = await accountId(book.bookId, "1020");

    const paid = await payments.postPayment(
      book.orgId,
      USER_ID,
      postApPaymentSchema.parse({
        bookId: book.bookId,
        partyId: vendor,
        paymentDate: ISSUE_DATE,
        paymentAccountId: bank,
        allocations: [{ documentId: bill.document.id, amountMinor: 5_000 }],
      }),
    );

    expect((await documents.get(book.orgId, bill.document.id)).status).toBe("PARTIALLY_PAID");
    expect((await trialBalance(book))["2100"]).toBe(-6_800);

    const reversed = await payments.reversePayment(book.orgId, USER_ID, paid.payment.id);
    expect(reversed.status).toBe("REVERSED");
    expect(reversed.allocations).toEqual([]);

    const restored = await documents.get(book.orgId, bill.document.id);
    expect(restored.status).toBe("POSTED");
    expect(restored.settledMinor).toBe(0);
    expect((await trialBalance(book))["2100"]).toBe(-11_800);
    expect((await trialBalance(book))["1020"]).toBe(0);
  });

  it("refuses to allocate more than the bill has open", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });
    const bank = await accountId(book.bookId, "1020");

    await expect(
      payments.postPayment(
        book.orgId,
        USER_ID,
        postApPaymentSchema.parse({
          bookId: book.bookId,
          partyId: vendor,
          paymentDate: ISSUE_DATE,
          paymentAccountId: bank,
          grossMinor: 20_000,
          allocations: [{ documentId: bill.document.id, amountMinor: 20_000 }],
        }),
      ),
    ).rejects.toThrow(/only 11800 open/i);
  });
});

/* ------------------------------------------------------------ acceptance 5 */

describe("5 — a payment with 10% withholding", () => {
  it("pays the vendor 90, owes the state 10, and clears the bill for 100", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, {
      name: "Professional Services LLP",
      region: KARNATAKA,
      gstin: "29AAACX5678A1Z5",
      withholdingCode: "194J",
    });
    // A zero-rated line so the base for TDS is the whole ₹100,000 — India
    // withholds on the invoice value, not on the GST.
    const bill = await makeAndPost(book, vendor, {
      unitPriceMinor: 10_000_000,
      taxCategory: "zero",
    });
    expect(bill.document.grossMinor).toBe(10_000_000);

    const bank = await accountId(book.bookId, "1020");
    const result = await payments.postPayment(
      book.orgId,
      USER_ID,
      postApPaymentSchema.parse({
        bookId: book.bookId,
        partyId: vendor,
        paymentDate: ISSUE_DATE,
        paymentAccountId: bank,
        allocations: [{ documentId: bill.document.id, amountMinor: 10_000_000 }],
      }),
    );

    expect(result.payment.grossMinor).toBe(10_000_000);
    expect(result.payment.withheldMinor).toBe(1_000_000);
    expect(result.payment.netPaidMinor).toBe(9_000_000);

    // Both identifiers are stored: practice speaks 194J, the 2025 Act §393.
    expect(result.payment.withholding).toHaveLength(1);
    expect(result.payment.withholding[0].legacySection).toBe("194J");
    expect(result.payment.withholding[0].paymentCode).toMatch(/^393\//);
    expect(result.payment.withholding[0].rateBp).toBe(1000);
    expect(result.payment.withholding[0].baseMinor).toBe(10_000_000);

    const settled = await documents.get(book.orgId, bill.document.id);
    expect(settled.status).toBe("PAID");
    expect(settled.openMinor).toBe(0);

    const balances = await trialBalance(book);
    expect(balances["2100"]).toBe(0); // AP cleared for the full 100
    expect(balances["2300"]).toBe(-1_000_000); // withholding payable, 10
    expect(balances["1020"]).toBe(-9_000_000); // the vendor received 90
  });

  it("keeps net = gross − withheld, which the CHECK constraint also insists on", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, {
      region: KARNATAKA,
      gstin: "29AAACX5678A1Z5",
      withholdingCode: "194J",
    });
    const bill = await makeAndPost(book, vendor, {
      unitPriceMinor: 10_000_000,
      taxCategory: "zero",
    });
    const bank = await accountId(book.bookId, "1020");
    const result = await payments.postPayment(
      book.orgId,
      USER_ID,
      postApPaymentSchema.parse({
        bookId: book.bookId,
        partyId: vendor,
        paymentDate: ISSUE_DATE,
        paymentAccountId: bank,
        allocations: [{ documentId: bill.document.id, amountMinor: 10_000_000 }],
      }),
    );

    const [row] = await db
      .select({
        grossMinor: apPayments.grossMinor,
        withheldMinor: apPayments.withheldMinor,
        netPaidMinor: apPayments.netPaidMinor,
      })
      .from(apPayments)
      .where(eq(apPayments.id, result.payment.id));
    expect(row.netPaidMinor).toBe(row.grossMinor - row.withheldMinor);
  });

  it("unwinds the withholding when the payment is reversed", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, {
      region: KARNATAKA,
      gstin: "29AAACX5678A1Z5",
      withholdingCode: "194J",
    });
    const bill = await makeAndPost(book, vendor, {
      unitPriceMinor: 10_000_000,
      taxCategory: "zero",
    });
    const bank = await accountId(book.bookId, "1020");
    const result = await payments.postPayment(
      book.orgId,
      USER_ID,
      postApPaymentSchema.parse({
        bookId: book.bookId,
        partyId: vendor,
        paymentDate: ISSUE_DATE,
        paymentAccountId: bank,
        allocations: [{ documentId: bill.document.id, amountMinor: 10_000_000 }],
      }),
    );

    await payments.reversePayment(book.orgId, USER_ID, result.payment.id);

    const remaining = await db
      .select({ id: apWithholding.id })
      .from(apWithholding)
      .where(eq(apWithholding.paymentId, result.payment.id));
    expect(remaining).toEqual([]);

    const balances = await trialBalance(book);
    expect(balances["2300"]).toBe(0);
    expect(balances["1020"]).toBe(0);
    expect(balances["2100"]).toBe(-10_000_000);
  });

  it("withholds nothing when the vendor carries no code", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });
    const bank = await accountId(book.bookId, "1020");

    const result = await payments.postPayment(
      book.orgId,
      USER_ID,
      postApPaymentSchema.parse({
        bookId: book.bookId,
        partyId: vendor,
        paymentDate: ISSUE_DATE,
        paymentAccountId: bank,
        allocations: [{ documentId: bill.document.id, amountMinor: 11_800 }],
      }),
    );

    expect(result.payment.withheldMinor).toBe(0);
    expect(result.payment.netPaidMinor).toBe(11_800);
    const journal = await ledger.loadJournal(book.orgId, result.journalId);
    // Dr AP / Cr bank, and nothing in between.
    expect(journal!.lines).toHaveLength(2);
  });
});

/* ------------------------------------------------------------ acceptance 6 */

describe("6 — a debit note restores", () => {
  it("mirrors the bill in the ledger and clears it when applied", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });

    expect((await trialBalance(book))["2100"]).toBe(-11_800);

    const note = await makeAndPost(book, vendor, {
      documentType: "DEBIT_NOTE",
      unitPriceMinor: 10_000,
      originalDocumentId: bill.document.id,
    });
    expect(note.document.documentNumber).toMatch(/^DBN\/2026-27\/\d+$/);
    expect(note.document.grossMinor).toBe(11_800);

    // Every side is the mirror: AP back to nil, input tax reversed, expense
    // credited back out.
    const balances = await trialBalance(book);
    expect(balances["2100"]).toBe(0);
    expect(balances["5300"]).toBe(0);
    expect(balances["1200"]).toBe(0);
    expect(balances["1210"]).toBe(0);

    const applied = await payments.allocateDebitNote(book.orgId, USER_ID, note.document.id, {
      allocations: [{ documentId: bill.document.id, amountMinor: 11_800 }],
    });
    expect(applied.remainingMinor).toBe(0);

    expect((await documents.get(book.orgId, bill.document.id)).status).toBe("PAID");
    expect((await documents.get(book.orgId, note.document.id)).status).toBe("PAID");

    // Applying is bookkeeping between open items — it posts no journal.
    const journals = await db
      .select({ id: glJournals.id })
      .from(glJournals)
      .where(eq(glJournals.bookId, book.bookId));
    expect(journals).toHaveLength(2);
  });

  it("refuses to apply more than the note has left", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });
    const note = await makeAndPost(book, vendor, {
      documentType: "DEBIT_NOTE",
      unitPriceMinor: 5_000,
    });

    await expect(
      payments.allocateDebitNote(book.orgId, USER_ID, note.document.id, {
        allocations: [{ documentId: bill.document.id, amountMinor: 11_800 }],
      }),
    ).rejects.toThrow(/only 5900 left to apply/i);
  });
});

/* ------------------------------------------------------------ acceptance 7 */

describe("7 — posting twice is idempotent", () => {
  it("returns the original journal and writes no second one", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeDocument(book, vendor, { unitPriceMinor: 10_000 });

    const first = await documents.post(book.orgId, USER_ID, bill.id);
    const second = await documents.post(book.orgId, USER_ID, bill.id);

    expect(second.journalId).toBe(first.journalId);
    expect(second.replayed).toBe(true);
    expect(second.document.documentNumber).toBe(first.document.documentNumber);

    const journals = await db
      .select({ id: glJournals.id, idempotencyKey: glJournals.idempotencyKey })
      .from(glJournals)
      .where(and(eq(glJournals.bookId, book.bookId), eq(glJournals.sourceId, bill.id)));
    expect(journals).toHaveLength(1);
    expect(journals[0].idempotencyKey).toBe(`purchase_bill:${bill.id}:post`);

    // …and the ledger still only sees one bill.
    expect((await trialBalance(book))["2100"]).toBe(-11_800);
  });
});

/* ------------------------------------------------------------ acceptance 8 */

describe("8 — aged payables tie to the AP control account", () => {
  it("buckets by age and totals to the GL balance", async () => {
    const book = await indiaBook();
    const vendorA = await createVendor(book, {
      name: "Vendor A",
      region: KARNATAKA,
      gstin: "29AAACX1111A1Z5",
    });
    const vendorB = await createVendor(book, {
      name: "Vendor B",
      region: MAHARASHTRA,
      gstin: "27AAACX2222A1Z5",
    });

    // One bill per bucket, plus a part payment and an unapplied debit note.
    const current = await makeAndPost(book, vendorA, {
      unitPriceMinor: 10_000,
      issueDate: "2026-08-01",
      dueDate: "2026-08-25",
    });
    const thirty = await makeAndPost(book, vendorA, {
      unitPriceMinor: 20_000,
      issueDate: "2026-07-01",
      dueDate: "2026-07-25",
    });
    const sixty = await makeAndPost(book, vendorB, {
      unitPriceMinor: 30_000,
      issueDate: "2026-06-01",
      dueDate: "2026-06-25",
    });
    const ninety = await makeAndPost(book, vendorB, {
      unitPriceMinor: 40_000,
      issueDate: "2026-05-01",
      dueDate: "2026-05-01",
    });

    const bank = await accountId(book.bookId, "1020");
    await payments.postPayment(
      book.orgId,
      USER_ID,
      postApPaymentSchema.parse({
        bookId: book.bookId,
        partyId: vendorA,
        paymentDate: "2026-08-10",
        paymentAccountId: bank,
        allocations: [{ documentId: thirty.document.id, amountMinor: 10_000 }],
      }),
    );
    const note = await makeAndPost(book, vendorB, {
      documentType: "DEBIT_NOTE",
      unitPriceMinor: 5_000,
      issueDate: "2026-08-05",
      dueDate: "2026-08-05",
    });

    const report = await aging.agedPayables(
      book.orgId,
      apAgingQuerySchema.parse({ bookId: book.bookId, asOf: AS_OF }),
    );

    // 0-30 holds the current bill and the unapplied debit note (negative).
    expect(report.buckets["0-30"]).toBe(11_800 - 5_900);
    expect(report.buckets["31-60"]).toBe(23_600 - 10_000);
    expect(report.buckets["61-90"]).toBe(35_400);
    expect(report.buckets["91+"]).toBe(47_200);

    const balances = await trialBalance(book, AS_OF);
    // The whole point: derived from open items, equal to the control account.
    expect(report.totalMinor).toBe(-balances["2100"]);

    const items = report.parties.flatMap((p) => p.items);
    expect(items.find((i) => i.documentId === current.document.id)!.bucket).toBe("0-30");
    expect(items.find((i) => i.documentId === sixty.document.id)!.bucket).toBe("61-90");
    expect(items.find((i) => i.documentId === ninety.document.id)!.bucket).toBe("91+");
    expect(items.find((i) => i.documentId === note.document.id)!.openMinor).toBe(-5_900);
  });

  it("answers as of a past date, ignoring a later payment", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeAndPost(book, vendor, {
      unitPriceMinor: 10_000,
      issueDate: "2026-06-01",
      dueDate: "2026-06-30",
    });
    const bank = await accountId(book.bookId, "1020");
    await payments.postPayment(
      book.orgId,
      USER_ID,
      postApPaymentSchema.parse({
        bookId: book.bookId,
        partyId: vendor,
        paymentDate: "2026-08-20",
        paymentAccountId: bank,
        allocations: [{ documentId: bill.document.id, amountMinor: 11_800 }],
      }),
    );

    const before = await aging.agedPayables(
      book.orgId,
      apAgingQuerySchema.parse({ bookId: book.bookId, asOf: "2026-07-31" }),
    );
    const after = await aging.agedPayables(
      book.orgId,
      apAgingQuerySchema.parse({ bookId: book.bookId, asOf: "2026-08-31" }),
    );

    expect(before.totalMinor).toBe(11_800);
    expect(before.totalMinor).toBe(-(await trialBalance(book, "2026-07-31"))["2100"]);
    expect(after.totalMinor).toBe(0);
  });
});

/* -------------------------------------------- M3: the duplicate vendor bill */

describe("M3 — the same vendor number cannot be entered twice", () => {
  it("comes back as a 409, never a 500", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });

    await makeDocument(book, vendor, { vendorDocumentNumber: "ACME-2026-001" });

    const duplicate = makeDocument(book, vendor, { vendorDocumentNumber: "ACME-2026-001" });
    await expect(duplicate).rejects.toBeInstanceOf(ConflictException);

    // The response carries a machine-readable code as well as the sentence, so
    // a client branches on the cause rather than pattern-matching the text.
    const rejection = await duplicate.catch((error: unknown) => error);
    const body = (rejection as ConflictException).getResponse() as {
      code?: string;
      message?: string;
      vendorDocumentNumber?: string | null;
    };
    expect(body.code).toBe("DUPLICATE_VENDOR_DOCUMENT_NUMBER");
    expect(body.vendorDocumentNumber).toBe("ACME-2026-001");
    expect(body.message).toMatch(/already been entered with document number/i);
  });

  it("lets a different vendor use the same number", async () => {
    const book = await indiaBook();
    const first = await createVendor(book, {
      name: "First",
      region: KARNATAKA,
      gstin: "29AAACX1111A1Z5",
    });
    const second = await createVendor(book, {
      name: "Second",
      region: KARNATAKA,
      gstin: "29AAACX2222A1Z5",
    });

    await makeDocument(book, first, { vendorDocumentNumber: "INV-1" });
    await expect(makeDocument(book, second, { vendorDocumentNumber: "INV-1" })).resolves.toBeTruthy();
  });

  it("frees the number again once the draft is deleted", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeDocument(book, vendor, { vendorDocumentNumber: "TYPO-1" });
    await documents.remove(book.orgId, bill.id);
    await expect(makeDocument(book, vendor, { vendorDocumentNumber: "TYPO-1" })).resolves.toBeTruthy();
  });
});

/* ------------------------------------------- M8: blocked input tax is a cost */

describe("M8 — blocked input tax is costed, not capitalised", () => {
  it("posts the non-recoverable component to expense rather than to a tax asset", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, {
      name: "Corporate Hospitality",
      region: KARNATAKA,
      gstin: "29AAACX1234A1Z5",
    });

    const posted = await makeAndPost(book, vendor, {
      unitPriceMinor: 10_000,
      blockedInputTax: true,
    });

    // The vendor still charges the tax, so AP is the full 118…
    expect(posted.document.taxMinor).toBe(1_800);
    expect(posted.document.grossMinor).toBe(11_800);

    const balances = await trialBalance(book);
    expect(balances["2100"]).toBe(-11_800);
    // …but nothing is recoverable, so the whole 118 sits in expense.
    expect(balances["5300"]).toBe(11_800);
    expect(balances["1200"]).toBeUndefined();
    expect(balances["1210"]).toBeUndefined();

    const frozen = await db
      .select({
        recoverable: taxDocumentLines.recoverable,
        glAccountId: taxDocumentLines.glAccountId,
      })
      .from(taxDocumentLines)
      .where(eq(taxDocumentLines.documentId, posted.document.id));
    const opex = await accountId(book.bookId, "5300");
    expect(frozen).toHaveLength(2);
    for (const row of frozen) {
      expect(row.recoverable).toBe(false);
      // The frozen line names the account the journal really used.
      expect(row.glAccountId).toBe(opex);
    }
  });
});

/* ------------------------------------------- posted documents are immutable */

describe("a posted document is immutable", () => {
  it("rejects an edit with 409", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const posted = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });

    const edit = documents.update(book.orgId, posted.document.id, { memo: "second thoughts" });
    await expect(edit).rejects.toBeInstanceOf(ConflictException);
    await expect(edit).rejects.toThrow(/immutable/i);
  });

  it("rejects a delete with 409", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const posted = await makeAndPost(book, vendor, { unitPriceMinor: 10_000 });

    await expect(documents.remove(book.orgId, posted.document.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("still allows a draft to be edited and re-costed", async () => {
    const book = await indiaBook();
    const vendor = await createVendor(book, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeDocument(book, vendor, { unitPriceMinor: 10_000 });

    const updated = await documents.update(book.orgId, bill.id, {
      lines: [
        {
          description: "Consulting, revised",
          quantityMilli: 2_500,
          unitPriceMinor: 10_000,
          discountMinor: 1_000,
          taxCategory: "standard",
          capitalize: false,
        },
      ],
    });
    // 2.5 × 100.00 − 10.00 = 240.00
    expect(updated.lines[0].lineNetMinor).toBe(24_000);

    const posted = await documents.post(book.orgId, USER_ID, bill.id);
    expect(posted.document.netMinor).toBe(24_000);
    expect(posted.document.grossMinor).toBe(28_320);
  });
});

/* ------------------------------------------------------- tenant isolation */

describe("cross-tenant access", () => {
  it("resolves another org's document as 404, never 403", async () => {
    const mine = await indiaBook();
    const theirs = await indiaBook();
    const vendor = await createVendor(theirs, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });
    const bill = await makeDocument(theirs, vendor, { unitPriceMinor: 10_000 });

    await expect(documents.get(mine.orgId, bill.id)).rejects.toThrow(/not found/i);
  });

  it("resolves another org's vendor as 404 when billing", async () => {
    const mine = await indiaBook();
    const theirs = await indiaBook();
    const vendor = await createVendor(theirs, { region: KARNATAKA, gstin: "29AAACX1234A1Z5" });

    await expect(makeDocument(mine, vendor, { unitPriceMinor: 10_000 })).rejects.toThrow(
      /vendor not found/i,
    );
  });
});
