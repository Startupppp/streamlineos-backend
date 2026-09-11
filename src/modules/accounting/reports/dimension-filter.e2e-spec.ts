/**
 * Filtering a report by dimension — PRD 06 S4.
 *
 * The subtle part is what a filter does to the trial balance's own promise. A
 * dimension sits on the journal *line*, not the account, and nothing forces
 * both sides of a journal to carry the same one — so a filtered trial balance
 * is a genuine slice of activity that is not expected to balance. The report
 * has to say that, or a reader sees `balanced: false` and reasonably concludes
 * the ledger is broken.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../db/schema";
import { glAccounts, orgUnits, organizationMembers, organizations, users } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { PackRegistry } from "../packs/pack.registry";
import { BooksService } from "../kernel/books.service";
import { LedgerService } from "../kernel/ledger.service";
import { SequenceService } from "../kernel/sequence.service";
import { TrialBalanceService } from "./trial-balance.service";
import { ProfitLossService } from "./profit-loss.service";

const DATE = "2026-08-25";

let client: ReturnType<typeof postgres>;
let db: Db;
let books: BooksService;
let ledger: LedgerService;
let trialBalance: TrialBalanceService;
let profitLoss: ProfitLossService;

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

async function seedOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = `acc-dim-${crypto.randomUUID()}`;
  const userId = `acc-dim-u-${crypto.randomUUID()}`;
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
  return { orgId, userId };
}

async function accountId(bookId: string, code: string): Promise<string> {
  const [row] = await db
    .select({ id: glAccounts.id })
    .from(glAccounts)
    .where(and(eq(glAccounts.bookId, bookId), eq(glAccounts.code, code)))
    .limit(1);
  if (!row) throw new Error(`fixture missing account ${code}`);
  return row.id;
}

async function branch(orgId: string, name: string): Promise<string> {
  const [row] = await db
    .insert(orgUnits)
    // `code` is NOT NULL with no default on org_units.
    .values({ orgId, name, kind: "BRANCH", code: `${name.toUpperCase()}-${Date.now() % 100000}` })
    .returning({ id: orgUnits.id });
  return row.id;
}

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  client = postgres(url, { prepare: false, max: 5 });
  db = drizzle(client, { schema }) as unknown as Db;

  const packs = new PackRegistry();
  const sequences = new SequenceService(db);
  books = new BooksService(db, packs);
  ledger = new LedgerService(db, sequences, packs);
  trialBalance = new TrialBalanceService(db, books);
  profitLoss = new ProfitLossService(db, books);
});

afterAll(async () => {
  if (createdOrgIds.length) await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
  await client?.end({ timeout: 5 });
});

/** Two branches, each with its own revenue and rent, on one set of books. */
async function twoBranchBooks() {
  const { orgId, userId } = await seedOrg();
  const book = await books.enable(orgId, userId, {
    countryCode: "IN",
    packCode: "IN",
    baseCurrency: "INR",
    openFrom: DATE,
  });

  const bengaluru = await branch(orgId, "Bengaluru");
  const mumbai = await branch(orgId, "Mumbai");

  const bank = await accountId(book.id, "1020");
  const sales = await accountId(book.id, "4100");
  const rent = await accountId(book.id, "5310");

  const post = (key: string, lines: Parameters<typeof ledger.post>[2]["lines"]) =>
    ledger.post(orgId, userId, {
      bookId: book.id,
      idempotencyKey: key,
      journalDate: DATE,
      sourceType: "manual",
      lines,
    });

  await post("manual:blr-sale:post", [
    { accountId: bank, debitMinor: 300_000, dimensionBranchId: bengaluru },
    { accountId: sales, creditMinor: 300_000, dimensionBranchId: bengaluru },
  ]);
  await post("manual:blr-rent:post", [
    { accountId: rent, debitMinor: 80_000, dimensionBranchId: bengaluru },
    { accountId: bank, creditMinor: 80_000, dimensionBranchId: bengaluru },
  ]);
  await post("manual:mum-sale:post", [
    { accountId: bank, debitMinor: 120_000, dimensionBranchId: mumbai },
    { accountId: sales, creditMinor: 120_000, dimensionBranchId: mumbai },
  ]);

  return { orgId, book, bengaluru, mumbai };
}

describe("filtering a report by branch", () => {
  it("narrows the trial balance to one branch's activity", async () => {
    const f = await twoBranchBooks();

    const all = await trialBalance.run(f.orgId, { asOf: DATE });
    const blr = await trialBalance.run(f.orgId, { asOf: DATE, branchId: f.bengaluru });

    const line = (report: typeof all, code: string) =>
      report.lines.find((l) => l.code === code);

    // Both branches: 420,000 of sales. Bengaluru alone: 300,000.
    expect(line(all, "4100")?.creditMinor).toBe(420_000);
    expect(line(blr, "4100")?.creditMinor).toBe(300_000);
    // Rent is Bengaluru's only.
    expect(line(blr, "5310")?.debitMinor).toBe(80_000);
  });

  it("says plainly that a filtered slice is not expected to balance", async () => {
    const f = await twoBranchBooks();

    const all = await trialBalance.run(f.orgId, { asOf: DATE });
    expect(all.filtered).toBe(false);
    expect(all.balanced).toBe(true);
    expect(all.notes).toEqual([]);

    const blr = await trialBalance.run(f.orgId, { asOf: DATE, branchId: f.bengaluru });
    expect(blr.filtered).toBe(true);
    expect(blr.notes[0]).toMatch(/not expected to balance/i);
  });

  it("narrows the profit and loss the same way", async () => {
    const f = await twoBranchBooks();

    const all = await profitLoss.run(f.orgId, { from: DATE, to: DATE });
    const mum = await profitLoss.run(f.orgId, { from: DATE, to: DATE, branchId: f.mumbai });

    // Everywhere: 420,000 revenue less 80,000 rent. Mumbai: 120,000, no rent.
    expect(all.netProfitMinor).toBe(340_000);
    expect(mum.netProfitMinor).toBe(120_000);
  });

  it("returns nothing for a branch that has posted nothing", async () => {
    const f = await twoBranchBooks();
    const empty = await branch(f.orgId, "Chennai");

    const report = await trialBalance.run(f.orgId, { asOf: DATE, branchId: empty });
    expect(report.lines).toHaveLength(0);
    expect(report.totalDebitMinor).toBe(0);
  });

  it("leaves the unfiltered report exactly as it was", async () => {
    const f = await twoBranchBooks();

    const before = await trialBalance.run(f.orgId, { asOf: DATE });
    await trialBalance.run(f.orgId, { asOf: DATE, branchId: f.bengaluru });
    const after = await trialBalance.run(f.orgId, { asOf: DATE });

    expect(after).toEqual(before);
    expect(after.balanced).toBe(true);
  });
});
