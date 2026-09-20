/**
 * Attachments on accounting documents — `09-feature-backlog.md` §N, v1.
 *
 * Runs against a real Postgres, because most of what is being proven does not
 * exist in a mock: the composite tenant keys, the partial index the list query
 * rides, `document_type` + `document_id` resolving through the owning table on
 * every call, and a soft delete that leaves the posted document alone.
 *
 * The bucket is the one thing stubbed. R2 is a seam, not the subject — and a
 * suite that writes real objects into the production bucket on every run is a
 * worse test, not a better one.
 *
 * Services are constructed with `new` rather than through Nest DI, the same way
 * `ar/ar.e2e-spec.ts` does: there is no request context to build.
 */
import { Readable } from "node:stream";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../../../db/schema";
import {
  glDocumentAttachments,
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
import { ArDocumentsService } from "../ar/ar-documents.service";
import { AttachmentsService } from "./attachments.service";
import { MAX_ATTACHMENT_BYTES } from "./dto/attachments.schemas";

const AS_OF = "2026-08-25";
const USER_ID = null;

/** The smallest thing `validateMagicBytes` will accept as a PDF. */
const VENDOR_BILL = Buffer.from("%PDF-1.4 vendor bill for August %%EOF", "latin1");
const VENDOR_BILL_B64 = VENDOR_BILL.toString("base64");

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let tax: TaxService;
let parties: PartiesService;
let documents: ArDocumentsService;
let attachments: AttachmentsService;
let storage: FakeStorage;
let owner: Fixture;
let intruder: Fixture;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

/**
 * An in-memory bucket standing in for R2.
 *
 * It mirrors the two behaviours the service depends on: `uploadFile` mints a
 * key the caller cannot predict, and `getFileStream` rejects when the object is
 * gone. `configured` is a switch so the "storage absent" path is testable.
 */
class FakeStorage {
  readonly objects = new Map<string, Buffer>();
  configured = true;

  isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Both methods take `orgId` first, exactly as `StorageService` does.
   *
   * They used to omit it, so every argument arrived one place to the left: an
   * upload keyed itself off the buffer, and a download looked the object up
   * under the org id instead of the key. The miss was indistinguishable from a
   * genuinely absent object, which is the behaviour this fake exists to model.
   */
  uploadFile(
    _orgId: string,
    buffer: Buffer,
    folder: string,
    fileName: string,
    mimeType: string,
  ) {
    const key = `${folder}/${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, "-")}`;
    this.objects.set(key, Buffer.from(buffer));
    return Promise.resolve({
      url: `https://files.test/${key}`,
      key,
      size: buffer.length,
      mimeType,
    });
  }

  getFileStream(_orgId: string, key: string) {
    const object = this.objects.get(key);
    if (!object) return Promise.reject(new NotFoundException("File not found or empty"));
    return Promise.resolve({
      body: Readable.from([object]),
      contentType: "application/octet-stream",
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
  const orgId = `acc-att-${crypto.randomUUID()}`;
  const userId = `acc-att-u-${crypto.randomUUID()}`;
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
  // Without a seller registration the India pack cannot determine, and posting
  // an invoice — the fixture every test here needs — fails before it starts.
  await db.insert(taxRegistrations).values({
    orgId,
    ownerType: "book",
    bookId: book.id,
    regime: "GST_IN",
    number: "29AABCU9603R1ZM",
    region: "29",
    countryCode: "IN",
    isPrimary: true,
  });
  return { orgId, userId, bookId: book.id };
}

async function postedInvoice(fixture: Fixture) {
  const party = await parties.create(fixture.orgId, USER_ID, {
    displayName: "Acme Industries",
    countryCode: "IN",
    defaultCurrency: "INR",
    billingRegion: "29",
    billingCountryCode: "IN",
  });
  const draft = await documents.createInvoice(fixture.orgId, USER_ID, {
    partyId: party.id,
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
  return documents.post(fixture.orgId, USER_ID, draft.id);
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set for the attachments suite");
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
    new ComplianceService(db, books),
  );

  storage = new FakeStorage();
  attachments = new AttachmentsService(db, storage as unknown as StorageService);

  // Two tenants, created once: enabling a book seeds an entire chart of
  // accounts, and nothing here mutates a book, so per-test books would buy
  // nothing but minutes.
  owner = await freshBook();
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

describe("attaching a file to a document", () => {
  it("uploads the bytes, records the metadata and lists it back", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);

    const created = await attachments.attach(
      fixture.orgId,
      fixture.userId,
      "sales_invoice",
      document.id,
      {
        fileName: "signed-contract.pdf",
        mimeType: "application/pdf",
        contentBase64: VENDOR_BILL_B64,
      },
    );

    expect(created.documentType).toBe("sales_invoice");
    expect(created.documentId).toBe(document.id);
    expect(created.bookId).toBe(fixture.bookId);
    expect(created.sizeBytes).toBe(VENDOR_BILL.length);
    expect(created.uploadedBy).toBe(fixture.userId);
    // Served by signed URL from `storageKey`; no public URL is stored.
    expect(created.storageUrl).toBeNull();

    const page = await attachments.list(fixture.orgId, "sales_invoice", document.id);
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe(created.id);
    expect(page.items[0].fileName).toBe("signed-contract.pdf");
  });

  it("hands the same bytes back on download", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);
    const created = await attachments.attach(
      fixture.orgId,
      fixture.userId,
      "sales_invoice",
      document.id,
      { fileName: "bill.pdf", mimeType: "application/pdf", contentBase64: VENDOR_BILL_B64 },
    );

    const downloaded = await attachments.download(fixture.orgId, created.id);
    expect(downloaded.fileName).toBe("bill.pdf");
    expect(downloaded.mimeType).toBe("application/pdf");
    expect(downloaded.buffer.equals(VENDOR_BILL)).toBe(true);
  });

  it("accepts a data: URI, because that is what a browser produces", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);
    const created = await attachments.attach(
      fixture.orgId,
      fixture.userId,
      "sales_invoice",
      document.id,
      {
        fileName: "bill.pdf",
        mimeType: "application/pdf",
        contentBase64: `data:application/pdf;base64,${VENDOR_BILL_B64}`,
      },
    );
    expect(created.sizeBytes).toBe(VENDOR_BILL.length);
  });

  it("attaches to a journal as readily as to an invoice", async () => {
    const fixture = owner;
    const { journal } = await postedInvoice(fixture);

    const created = await attachments.attach(fixture.orgId, fixture.userId, "journal", journal.id, {
      fileName: "board-approval.pdf",
      mimeType: "application/pdf",
      contentBase64: VENDOR_BILL_B64,
    });
    expect(created.documentType).toBe("journal");

    const page = await attachments.list(fixture.orgId, "journal", journal.id);
    expect(page.total).toBe(1);
  });

  it("keeps one document's attachments out of another's list", async () => {
    const fixture = owner;
    const first = await postedInvoice(fixture);
    const second = await postedInvoice(fixture);

    await attachments.attach(fixture.orgId, fixture.userId, "sales_invoice", first.document.id, {
      fileName: "first.pdf",
      mimeType: "application/pdf",
      contentBase64: VENDOR_BILL_B64,
    });

    expect((await attachments.list(fixture.orgId, "sales_invoice", first.document.id)).total).toBe(
      1,
    );
    expect((await attachments.list(fixture.orgId, "sales_invoice", second.document.id)).total).toBe(
      0,
    );
  });
});

describe("what an attachment refuses", () => {
  it("rejects a file whose bytes are not what its mime type claims", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);

    await expect(
      attachments.attach(fixture.orgId, fixture.userId, "sales_invoice", document.id, {
        fileName: "not-really.pdf",
        mimeType: "application/pdf",
        contentBase64: Buffer.from("MZ this is an executable").toString("base64"),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a file over the size cap", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);
    const oversized = Buffer.concat([
      Buffer.from("%PDF-1.4 ", "latin1"),
      Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x20),
    ]);

    await expect(
      attachments.attach(fixture.orgId, fixture.userId, "sales_invoice", document.id, {
        fileName: "huge.pdf",
        mimeType: "application/pdf",
        contentBase64: oversized.toString("base64"),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a payload that is not base64 at all", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);

    await expect(
      attachments.attach(fixture.orgId, fixture.userId, "sales_invoice", document.id, {
        fileName: "bill.pdf",
        mimeType: "application/pdf",
        contentBase64: "not base64 at all !!!",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses to accept bytes it cannot store", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);
    storage.configured = false;

    // Unlike the rendered invoice PDF, there is no fallback here: the bytes
    // exist only in this request, so a missing bucket has to be an error rather
    // than a silently discarded upload.
    await expect(
      attachments.attach(fixture.orgId, fixture.userId, "sales_invoice", document.id, {
        fileName: "bill.pdf",
        mimeType: "application/pdf",
        contentBase64: VENDOR_BILL_B64,
      }),
    ).rejects.toThrow(/storage is not configured/i);
  });

  it("treats a credit-note id on the invoice route as a miss", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);

    await expect(attachments.list(fixture.orgId, "credit_note", document.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("treats an unknown document id as a miss", async () => {
    const fixture = owner;
    await expect(
      attachments.list(fixture.orgId, "sales_invoice", crypto.randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("soft delete", () => {
  it("removes the attachment from the list without touching the document", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);
    const created = await attachments.attach(
      fixture.orgId,
      fixture.userId,
      "sales_invoice",
      document.id,
      { fileName: "bill.pdf", mimeType: "application/pdf", contentBase64: VENDOR_BILL_B64 },
    );

    const before = await documents.get(fixture.orgId, document.id);

    expect(await attachments.remove(fixture.orgId, created.id)).toEqual({
      id: created.id,
      deleted: true,
    });

    // Gone from every read path.
    expect((await attachments.list(fixture.orgId, "sales_invoice", document.id)).total).toBe(0);
    await expect(attachments.get(fixture.orgId, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(attachments.download(fixture.orgId, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // The row is soft-deleted, not gone: the audit trail survives.
    const [row] = await db
      .select({ deletedAt: glDocumentAttachments.deletedAt })
      .from(glDocumentAttachments)
      .where(eq(glDocumentAttachments.id, created.id));
    expect(row.deletedAt).toBeInstanceOf(Date);

    // A posted document's attachments stay attached: deleting one changes
    // nothing about the invoice, its number or its journal.
    const after = await documents.get(fixture.orgId, document.id);
    expect(after.status).toBe(before.status);
    expect(after.documentNumber).toBe(before.documentNumber);
    expect(after.postedJournalId).toBe(before.postedJournalId);
    expect(after.grossMinor).toBe(before.grossMinor);
    const [invoice] = await db
      .select({ deletedAt: arDocuments.deletedAt })
      .from(arDocuments)
      .where(and(eq(arDocuments.id, document.id), isNull(arDocuments.deletedAt)));
    expect(invoice).toBeDefined();
  });

  it("makes a second delete a miss rather than a crash", async () => {
    const fixture = owner;
    const { document } = await postedInvoice(fixture);
    const created = await attachments.attach(
      fixture.orgId,
      fixture.userId,
      "sales_invoice",
      document.id,
      { fileName: "bill.pdf", mimeType: "application/pdf", contentBase64: VENDOR_BILL_B64 },
    );

    await attachments.remove(fixture.orgId, created.id);
    await expect(attachments.remove(fixture.orgId, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("tenant isolation", () => {
  it("answers 404 rather than 403 on every path into another org's data", async () => {
    const { document } = await postedInvoice(owner);
    const created = await attachments.attach(
      owner.orgId,
      owner.userId,
      "sales_invoice",
      document.id,
      { fileName: "bill.pdf", mimeType: "application/pdf", contentBase64: VENDOR_BILL_B64 },
    );

    // A 403 would confirm the row exists and turn a probe into an existence
    // oracle (backend/CLAUDE.md §4).
    await expect(
      attachments.list(intruder.orgId, "sales_invoice", document.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      attachments.attach(intruder.orgId, intruder.userId, "sales_invoice", document.id, {
        fileName: "evil.pdf",
        mimeType: "application/pdf",
        contentBase64: VENDOR_BILL_B64,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(attachments.get(intruder.orgId, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(attachments.download(intruder.orgId, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(attachments.remove(intruder.orgId, created.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // And the owner still has it, untouched.
    expect((await attachments.list(owner.orgId, "sales_invoice", document.id)).total).toBe(1);
  });
});
