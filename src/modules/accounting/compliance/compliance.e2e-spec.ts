/**
 * E-invoicing state — PRD 13 acceptance.
 *
 * v1 records *whether* a document would need reporting and calls nothing. The
 * property that matters most is the last one: posting must succeed regardless,
 * because enforcement is off and a founder should never lose the ability to
 * invoice because a government endpoint is unreachable.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import {
  documentCompliance,
  organizationMembers,
  organizations,
  taxRegistrations,
  users,
} from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "../kernel/books.service";
import { ComplianceService } from "./compliance.service";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let compliance: ComplianceService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

async function seedOrg(): Promise<string> {
  const orgId = `acc-comp-${crypto.randomUUID()}`;
  const userId = `acc-comp-u-${crypto.randomUUID()}`;
  createdOrgIds.push(orgId);
  createdUserIds.push(userId);
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ id: userId, email: `${userId}@accounting.test` }).onConflictDoNothing();
    await tx
      .insert(organizations)
      .values({ id: orgId, name: orgId, slug: orgId, ownerMembershipId: 0 })
      .onConflictDoNothing();
    const [m] = await tx
      .insert(organizationMembers)
      .values({ orgId, userId, isOwner: true })
      .returning({ id: organizationMembers.id });
    await tx.update(organizations).set({ ownerMembershipId: m.id }).where(eq(organizations.id, orgId));
  });
  return orgId;
}

async function bookFor(pack: "IN" | "GENERIC_VAT", withGstin: boolean) {
  const orgId = await seedOrg();
  const book = await books.enable(orgId, null, {
    countryCode: pack === "IN" ? "IN" : "PT",
    packCode: pack,
    baseCurrency: pack === "IN" ? "INR" : "EUR",
    openFrom: "2026-08-25",
  });
  if (withGstin) {
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
  }
  return { orgId, book };
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  client = postgres(url, { prepare: false, max: 5 });
  db = drizzle(client, { schema }) as unknown as Db;
  books = new BooksService(db, new PackRegistry());
  compliance = new ComplianceService(db);
});

afterAll(async () => {
  if (createdOrgIds.length) await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  await client?.end({ timeout: 5 });
});

describe("1 — an India B2B invoice is marked pending", () => {
  it("routes to the IRP without calling it", async () => {
    const { orgId, book } = await bookFor("IN", true);

    const decision = await compliance.recordForDocument(
      orgId,
      book.id,
      "sales_invoice",
      "doc-b2b",
      { supplyNature: "domestic_b2b", sellerHasTaxId: true, buyerHasTaxId: true },
    );

    expect(decision.transport).toBe("irp");
    expect(decision.status).toBe("pending");

    const [row] = await compliance.get(orgId, book.id, "sales_invoice", "doc-b2b");
    expect(row.transport).toBe("irp");
    expect(row.status).toBe("pending");
    // Nothing was submitted, so there is no authority id yet — and the nullable
    // columns PRD 13 M4 asks for hold that state without a migration.
    expect(row.authorityId).toBeNull();
    expect(row.ackNo).toBeNull();
    expect(row.ackAt).toBeNull();
  });

  it("treats an export the same way", async () => {
    const { orgId, book } = await bookFor("IN", true);
    const decision = await compliance.recordForDocument(
      orgId,
      book.id,
      "sales_invoice",
      "doc-export",
      { supplyNature: "export", sellerHasTaxId: true, buyerHasTaxId: false },
    );
    expect(decision.status).toBe("pending");
  });

  it("does not report a B2C supply", async () => {
    const { orgId, book } = await bookFor("IN", true);
    const decision = await compliance.recordForDocument(
      orgId,
      book.id,
      "sales_invoice",
      "doc-b2c",
      { supplyNature: "domestic_b2c", sellerHasTaxId: true, buyerHasTaxId: false },
    );
    expect(decision.transport).toBe("none");
    expect(decision.status).toBe("not_required");
    expect(decision.reason).toMatch(/B2C/i);
  });

  it("does not report when the seller is not registered", async () => {
    const { orgId, book } = await bookFor("IN", false);
    const decision = await compliance.recordForDocument(
      orgId,
      book.id,
      "sales_invoice",
      "doc-unregistered",
      { supplyNature: "domestic_b2b", sellerHasTaxId: false, buyerHasTaxId: true },
    );
    expect(decision.status).toBe("not_required");
    expect(decision.reason).toMatch(/not GST registered/i);
  });
});

describe("2 — a generic VAT invoice needs nothing", () => {
  it("records not_required with no transport", async () => {
    const { orgId, book } = await bookFor("GENERIC_VAT", false);

    const decision = await compliance.recordForDocument(
      orgId,
      book.id,
      "sales_invoice",
      "doc-vat",
      { supplyNature: "domestic_b2b", sellerHasTaxId: true, buyerHasTaxId: true },
    );

    expect(decision.transport).toBe("none");
    expect(decision.status).toBe("not_required");
    expect(decision.reason).toMatch(/no e-reporting mandate/i);
  });
});

describe("3 — the record is idempotent", () => {
  it("does not duplicate when a document is recorded twice", async () => {
    const { orgId, book } = await bookFor("IN", true);
    const input = {
      supplyNature: "domestic_b2b",
      sellerHasTaxId: true,
      buyerHasTaxId: true,
    };

    await compliance.recordForDocument(orgId, book.id, "sales_invoice", "doc-twice", input);
    await compliance.recordForDocument(orgId, book.id, "sales_invoice", "doc-twice", input);

    const rows = await db
      .select()
      .from(documentCompliance)
      .where(
        and(
          eq(documentCompliance.bookId, book.id),
          eq(documentCompliance.documentId, "doc-twice"),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

describe("4 — enforcement is off, so nothing blocks", () => {
  it("records every document with enforcement off", async () => {
    const { orgId, book } = await bookFor("IN", true);
    await compliance.recordForDocument(orgId, book.id, "sales_invoice", "doc-enf", {
      supplyNature: "domestic_b2b",
      sellerHasTaxId: true,
      buyerHasTaxId: true,
    });

    const [row] = await db
      .select()
      .from(documentCompliance)
      .where(
        and(eq(documentCompliance.bookId, book.id), eq(documentCompliance.documentId, "doc-enf")),
      );

    // The whole v1 contract in one assertion: a pending IRN never gates a post.
    expect(row.enforcementAtPost).toBe("off");
  });

  it("knows whether the book carries a tax identity at all", async () => {
    const registered = await bookFor("IN", true);
    const unregistered = await bookFor("IN", false);

    expect(await compliance.bookHasTaxRegistration(registered.book.id)).toBe(true);
    expect(await compliance.bookHasTaxRegistration(unregistered.book.id)).toBe(false);
  });
});
