/**
 * The printable tax invoice, end to end — PRD 05 M6 and backlog §F.
 *
 * `lib/invoice-pdf.spec.ts` proves the renderer draws the right fields from a
 * given data object. This proves the other half: that a real posted invoice in
 * a real book actually produces those values — the seller GSTIN off the book's
 * registration, the HSN off the line, the CGST/SGST split off the frozen tax
 * rows — and that the caching, the draft refusal and the tenant boundary all
 * behave.
 *
 * The bucket is stubbed. R2 is a seam here, and a suite that writes real
 * objects into the production bucket every run is a worse test, not a better
 * one; the "storage absent" case is a switch on the same stub.
 */
import { Readable } from "node:stream";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { inflateSync } from "node:zlib";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import {
  arDocuments,
  organizationMembers,
  organizations,
  taxRegistrations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import type { StorageService } from "../../storage/storage.service";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService } from "../kernel/sequence.service";
import { TaxEngineRegistry } from "../tax/tax-engine.registry";
import { TaxService } from "../tax/tax.service";
import { PartiesService } from "../parties/parties.service";
import { ComplianceService } from "../compliance/compliance.service";
import { ArDocumentsService } from "./ar-documents.service";
import { ArDocumentPdfService } from "./ar-document-pdf.service";

const AS_OF = "2026-08-25";
const USER_ID = null;
const SELLER_GSTIN = "29AABCU9603R1ZM";
const BUYER_GSTIN = "29AAACT2727Q1ZW";
/** Karnataka — seller and buyer both, so the supply is intra-state. */
const KARNATAKA = "29";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let tax: TaxService;
let parties: PartiesService;
let documents: ArDocumentsService;
let pdf: ArDocumentPdfService;
let storage: FakeStorage;
let fixture: Fixture;
let intruder: Fixture;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

class FakeStorage {
  readonly objects = new Map<string, Buffer>();
  configured = true;
  uploads = 0;

  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * The signature has to match `StorageService.uploadFile` exactly.
   *
   * It used to omit `orgId`, so every argument arrived one place to the left:
   * the buffer bound to `folder`, and the key this built therefore had the raw
   * PDF inside it. That key then went into `ar_documents.pdf_storage_key`,
   * where the NUL bytes in the PDF header made PostgreSQL reject the UPDATE —
   * which the service catches and logs, so the only visible symptom was a
   * stored key of `null` two assertions later.
   */
  uploadFile(
    _orgId: string,
    buffer: Buffer,
    folder: string,
    fileName: string,
    mimeType: string,
  ) {
    this.uploads += 1;
    const key = `${folder}/${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, "-")}`;
    this.objects.set(key, Buffer.from(buffer));
    return Promise.resolve({ url: `https://files.test/${key}`, key, size: buffer.length, mimeType });
  }

  getFileStream(_orgId: string, key: string) {
    const object = this.objects.get(key);
    if (!object) return Promise.reject(new NotFoundException("File not found or empty"));
    return Promise.resolve({
      body: Readable.from([object]),
      contentType: "application/pdf",
      contentLength: object.length,
    });
  }
}

/**
 * Create a tenant the way the platform really does.
 *
 * `organizations.owner_membership_id` carries a composite FK back to
 * `organization_members`, so the two rows are mutually dependent. The
 * constraint is DEFERRABLE INITIALLY DEFERRED precisely for this.
 */
async function seedOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = `acc-pdf-${crypto.randomUUID()}`;
  const userId = `acc-pdf-u-${crypto.randomUUID()}`;
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
    const [m] = await tx
      .insert(organizationMembers)
      .values({ orgId, userId, isOwner: true })
      .returning({ id: organizationMembers.id });
    await tx
      .update(organizations)
      .set({ ownerMembershipId: m.id })
      .where(eq(organizations.id, orgId));
  });
  return { orgId, userId };
}

interface Fixture {
  orgId: string;
  userId: string;
  bookId: string;
}

async function freshBook(): Promise<Fixture> {
  const { orgId, userId } = await seedOrg();
  const book = await books.enable(orgId, USER_ID, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    openFrom: AS_OF,
  });
  await tax.seedPack(orgId, book.id, "IN");
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
  return { orgId, userId, bookId: book.id };
}

async function customer(target: Fixture): Promise<string> {
  const party = await parties.create(target.orgId, USER_ID, {
    displayName: "Acme Industries",
    legalName: "Acme Industries LLP",
    countryCode: "IN",
    defaultCurrency: "INR",
    billingLine1: "Plot 12, Residency Road",
    billingCity: "Bengaluru",
    billingRegion: KARNATAKA,
    billingPostalCode: "560025",
    billingCountryCode: "IN",
  });
  await parties.addRegistration(target.orgId, party.id, {
    regime: "GST_IN",
    number: BUYER_GSTIN,
    countryCode: "IN",
  });
  return party.id;
}

async function draftInvoice(target: Fixture) {
  return documents.createInvoice(target.orgId, USER_ID, {
    partyId: await customer(target),
    issueDate: AS_OF,
    lines: [
      {
        description: "Consulting services",
        quantityMilli: 1000,
        unitPriceMinor: 10_000,
        commodityCode: "998313",
      },
    ],
  });
}

async function postedInvoice(target: Fixture) {
  const draft = await draftInvoice(target);
  return documents.post(target.orgId, USER_ID, draft.id);
}

function inflateOrNull(chunk: Buffer): Buffer | null {
  try {
    return inflateSync(chunk);
  } catch {
    return null;
  }
}

/**
 * The text actually drawn on the page, read straight out of the content stream.
 *
 * `lib/invoice-pdf.spec.ts` reads its PDFs back with `pdf-parse`, which is the
 * right tool for a fixed fixture. It is the wrong tool here: pdf-parse bundles
 * a 2018 build of pdf.js that refuses some perfectly valid pdf-lib output with
 * "Invalid PDF structure" — files whose cross-reference stream checks out by
 * hand and which every modern viewer renders. Inflating the FlateDecode
 * streams and pulling the hex literals that `Tj` draws is both deterministic
 * and a closer read of what the customer will actually see.
 */
function drawnText(buffer: Buffer): string {
  const startMarker = Buffer.from("stream\n");
  const endMarker = Buffer.from("\nendstream");
  const drawn: string[] = [];

  let index = buffer.indexOf(startMarker);
  while (index !== -1) {
    const start = index + startMarker.length;
    const end = buffer.indexOf(endMarker, start);
    if (end === -1) break;

    const inflated = inflateOrNull(buffer.subarray(start, end));
    if (inflated) {
      const operators = inflated.toString("latin1");
      for (const match of operators.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
        drawn.push(Buffer.from(match[1], "hex").toString("latin1"));
      }
    }
    index = buffer.indexOf(startMarker, end);
  }
  return drawn.join(" ");
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for the invoice PDF suite");
  client = postgres(url, { prepare: false, max: 6 });
  db = drizzle(client, { schema }) as unknown as Db;

  const packs = new PackRegistry();
  const sequences = new SequenceService(db);
  books = new BooksService(db, packs);
  const ledger = new LedgerService(db, sequences, packs);
  tax = new TaxService(db, new TaxEngineRegistry());
  parties = new PartiesService(db, books);
  documents = new ArDocumentsService(
    db,
    books,
    ledger,
    sequences,
    packs,
    tax,
    parties,
    new ComplianceService(db),
  );

  storage = new FakeStorage();
  pdf = new ArDocumentPdfService(db, documents, parties, tax, storage as unknown as StorageService);

  // Enabling a book seeds an entire chart of accounts, so the two tenants are
  // created once and reused; nothing here mutates a book.
  fixture = await freshBook();
  intruder = await freshBook();
}, 120_000);

afterAll(async () => {
  if (createdOrgIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await client?.end({ timeout: 5 });
});

beforeEach(() => {
  storage.configured = true;
});

describe("the invoice PDF a posted document produces", () => {
  it("carries the real GSTIN, HSN and frozen tax split", async () => {
    const { document } = await postedInvoice(fixture);
    const rendered = await pdf.render(fixture.orgId, document.id, "INVOICE");

    expect(rendered.contentType).toBe("application/pdf");
    expect(rendered.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // The number is `INV/2026-27/0001`; slashes cannot travel in a filename.
    expect(rendered.fileName).toMatch(/^INV-[\d-]+\.pdf$/);

    const text = drawnText(rendered.buffer);
    expect(text).toContain("TAX INVOICE");
    expect(text).toContain(document.documentNumber);
    // The seller GSTIN comes off the book's own registration, not a constant.
    expect(text).toContain(SELLER_GSTIN);
    expect(text).toContain(BUYER_GSTIN);
    expect(text).toContain("Acme Industries LLP");
    // HSN/SAC per line (M3, M6).
    expect(text).toContain("998313");
    // Karnataka to Karnataka is intra-state, so 18% splits 9 + 9 (M2).
    expect(text).toContain("CGST");
    expect(text).toContain("SGST");
    expect(text).not.toContain("IGST");
    expect(text).toContain("9.00%");
    // 100.00 taxable, 9.00 each side, 118.00 payable.
    expect(text).toContain("100.00");
    expect(text).toContain("118.00");
    expect(text).toContain("Place of supply");
    expect(text).toContain("Reverse charge");
  });

  it("renders once and serves the stored bytes thereafter", async () => {
    const { document } = await postedInvoice(fixture);
    const uploadsBefore = storage.uploads;

    const first = await pdf.render(fixture.orgId, document.id, "INVOICE");
    expect(first.fromStore).toBe(false);
    expect(storage.uploads).toBe(uploadsBefore + 1);

    const [row] = await db
      .select({ key: arDocuments.pdfStorageKey, url: arDocuments.pdfStorageUrl })
      .from(arDocuments)
      .where(eq(arDocuments.id, document.id));
    expect(row.key).toBeTruthy();
    // The object is served by signed URL from its key; no public URL is stored.
    expect(row.url).toBeNull();

    const second = await pdf.render(fixture.orgId, document.id, "INVOICE");
    expect(second.fromStore).toBe(true);
    expect(second.buffer.equals(first.buffer)).toBe(true);
    // A posted document is immutable, so its PDF is rendered exactly once.
    expect(storage.uploads).toBe(uploadsBefore + 1);
  });

  it("re-renders rather than 500ing when the stored object has vanished", async () => {
    const { document } = await postedInvoice(fixture);
    await pdf.render(fixture.orgId, document.id, "INVOICE");
    storage.objects.clear();

    const again = await pdf.render(fixture.orgId, document.id, "INVOICE");
    expect(again.fromStore).toBe(false);
    expect(again.buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("still returns the bytes when object storage is not configured", async () => {
    const { document } = await postedInvoice(fixture);
    storage.configured = false;

    const rendered = await pdf.render(fixture.orgId, document.id, "INVOICE");
    expect(rendered.buffer.length).toBeGreaterThan(3_000);
    expect(rendered.fromStore).toBe(false);

    // Nothing was stored, so nothing claims to have been.
    const [row] = await db
      .select({ key: arDocuments.pdfStorageKey })
      .from(arDocuments)
      .where(eq(arDocuments.id, document.id));
    expect(row.key).toBeNull();
  });
});

describe("the credit note", () => {
  it("prints the invoice it corrects, and prints it negative", async () => {
    const { document: invoice } = await postedInvoice(fixture);
    const note = await documents.creditNoteFromInvoice(fixture.orgId, USER_ID, invoice.id);
    const posted = await documents.post(fixture.orgId, USER_ID, note.id);

    const rendered = await pdf.render(fixture.orgId, posted.document.id, "CREDIT_NOTE");
    const text = drawnText(rendered.buffer);

    expect(text).toContain("CREDIT NOTE");
    expect(text).toContain(posted.document.documentNumber);
    expect(text).toContain("Against invoice");
    expect(text).toContain(invoice.documentNumber);
    expect(text).toContain("Total credit");
    expect(text).toContain("-118.00");
    expect(text).not.toContain("Total payable");
  });
});

describe("what does not get a PDF", () => {
  it("refuses a draft, because it has no number and no frozen tax", async () => {
    const draft = await draftInvoice(fixture);
    await expect(pdf.render(fixture.orgId, draft.id, "INVOICE")).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(pdf.render(fixture.orgId, draft.id, "INVOICE")).rejects.toThrow(/still a draft/i);
  });

  it("treats a credit note asked for on the invoice route as a miss", async () => {
    const { document: invoice } = await postedInvoice(fixture);
    const note = await documents.creditNoteFromInvoice(fixture.orgId, USER_ID, invoice.id);
    const posted = await documents.post(fixture.orgId, USER_ID, note.id);

    await expect(
      pdf.render(fixture.orgId, posted.document.id, "INVOICE"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(pdf.render(fixture.orgId, invoice.id, "CREDIT_NOTE")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("answers 404, never 403, for another tenant's invoice", async () => {
    const { document } = await postedInvoice(fixture);
    // A 403 would confirm the invoice exists (backend/CLAUDE.md §4).
    await expect(pdf.render(intruder.orgId, document.id, "INVOICE")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
