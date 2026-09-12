/**
 * The command fence, over real HTTP, on an accounting posting route.
 *
 * `common/idempotency/idempotency.interceptor.spec.ts` proves the hash covers
 * the route params, and `modules/timesheets/.../idempotency-replay.spec.ts`
 * proves the consequence on a controller. Neither can prove the thing the whole
 * fix rests on: that **`req.params` is populated by the time the interceptor
 * runs**. Both build their `ExecutionContext` by hand, so both would keep
 * passing if Nest ran method interceptors before routing and every real request
 * arrived at `hashRequest` with an empty params object — at which point the fix
 * is inert on all 145 param-carrying fenced routes and nothing says so.
 *
 * So this one goes through supertest against a booted application, on a route
 * in a different module from the one the bug was found in. AR invoice posting
 * is the sharpest available example: `POST /accounting/ar/invoices/:invoiceId/post`
 * takes no body at all, so before the fix its request hash was
 * `{ commandName, body: null }` — identical for every invoice in the
 * organisation.
 *
 * **The harm, precisely.** `ArDocumentsService.post` is itself replay-safe: post
 * the same invoice twice and the second call returns the first one's journal
 * with `replayed: true`. That guard cannot help here, because under the bug the
 * handler never runs — the fence answers first, from a row claimed by a
 * *different* invoice. So a client reusing one key posts invoice A, then asks to
 * post invoice B and is handed A's journal with a 200. Invoice B is still a
 * draft, nothing is in the ledger for it, and the caller has been told it
 * posted. That is the failure this file exists to make impossible.
 */
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createE2eApp } from "../../../../test/helpers/e2e-app";
import {
  seedOrg,
  seedUser,
  cleanupSeedOrgs,
  cleanupSeedUsers,
} from "../../../../test/helpers/e2e-seed";
import { signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { arDocuments, auditLogs, commandFences } from "../../../db/schema";
import { BooksService } from "../kernel/books.service";
import { TaxService } from "../tax/tax.service";
import { PartiesService } from "../parties/parties.service";
import { ArDocumentsService } from "./ar-documents.service";

/** Well inside the fiscal year opened below. */
const ISSUE_DATE = "2026-08-25";

/**
 * Portugal on the generic VAT pack, not India.
 *
 * The India pack needs a seller GSTIN, a buyer GSTIN and matching state codes
 * before tax determination will produce a postable invoice. None of that is
 * what this file is about, and every extra precondition is another way for it
 * to fail for a reason that has nothing to do with the fence.
 */
const COUNTRY = "PT";
const CURRENCY = "EUR";

const ORG_ID = `acct-idem-e2e-${Math.random().toString(36).slice(2, 10)}`;
const USER_ID = `${ORG_ID}__actor`;

let app: INestApplication;
let db: Db;
let token: string;
let invoiceA: string;
let invoiceB: string;

/** `{ data: ... }` from the global response transformer, or the bare body. */
function payload(res: { body: Record<string, unknown> }): Record<string, unknown> {
  const body = res.body;
  const inner = body["data"];
  return (inner && typeof inner === "object" ? inner : body) as Record<string, unknown>;
}

function post(invoiceId: string, key: string) {
  return request(app.getHttpServer())
    .post(`/accounting/ar/invoices/${invoiceId}/post`)
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key);
}

async function documentStatus(id: string) {
  const [row] = await db
    .select({ status: arDocuments.status, journalId: arDocuments.postedJournalId })
    .from(arDocuments)
    .where(and(eq(arDocuments.orgId, ORG_ID), eq(arDocuments.id, id)))
    .limit(1);
  return row;
}

async function fencesFor(key: string) {
  return db
    .select({
      commandName: commandFences.commandName,
      status: commandFences.status,
      responseStatus: commandFences.responseStatus,
      requestHash: commandFences.requestHash,
    })
    .from(commandFences)
    .where(
      and(eq(commandFences.organizationId, ORG_ID), eq(commandFences.idempotencyKey, key)),
    );
}

/**
 * The fence is completed by a `void`-ed write in a `tap`, so it lands *after*
 * the response is sent. Every case below depends on the first command having
 * reached COMPLETED — a fence still IN_FLIGHT answers 409 and would make the
 * suite prove something other than what it claims, intermittently.
 */
async function awaitCompletedFence(key: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await fencesFor(key);
    if (row?.status === "COMPLETED") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fence for ${key} never reached COMPLETED`);
}

/**
 * The fixture is not cheap: booting `AppModule`, then `books.enable` seeding a
 * whole chart of accounts and `tax.seedPack` seeding the pack's codes.
 *
 * Hence the very generous budget. On a freshly migrated database — no planner
 * statistics, empty visibility map — all of that seq-scans, and against the
 * default the hook timed out mid-insert: jest moved on to `afterAll`, whose
 * cleanup `DELETE FROM organizations` then blocked against the orphaned inserts
 * still in flight, which presents as a hang rather than as a timeout. Running
 * `VACUUM ANALYZE` once after a cold build is the actual fix; this margin is
 * what stops a merely slow machine from reproducing that confusion.
 */
beforeAll(async () => {
  app = await createE2eApp();
  db = app.get<Db>(DRIZZLE);

  await seedOrg(db, ORG_ID, ORG_ID);
  /**
   * The actor is a real `users` row, not just a `sub` claim.
   *
   * `seedOrg` creates an owner named `<org>__seed_owner` and nothing else, so a
   * token minted for any other subject names a user that does not exist. The
   * guard chain never notices — the harness resolves membership and permissions
   * from the token — but `gl_journals.posted_by_user_id` carries a foreign key
   * to `users`, so posting died `23503` inside the handler and the route
   * answered 500. Which is worth stating plainly: the fence had already done its
   * job by then, so the suite still saw a 422 on the case that asserts one, and
   * that case passed while nothing had actually posted.
   */
  await seedUser(db, USER_ID, `${USER_ID}@accounting.test`);
  token = await signToken({
    sub: USER_ID,
    orgId: ORG_ID,
    isOrgOwner: false,
    permissions: ["accounting:receivables:manage"],
    enabledModules: ["accounting"],
  });

  const books = app.get(BooksService);
  const tax = app.get(TaxService);
  const parties = app.get(PartiesService);
  const documents = app.get(ArDocumentsService);

  const book = await books.enable(ORG_ID, null, {
    countryCode: COUNTRY,
    packCode: "GENERIC_VAT",
    baseCurrency: CURRENCY,
    openFrom: ISSUE_DATE,
  });
  await tax.seedPack(ORG_ID, book.id, "GENERIC_VAT");

  const party = await parties.create(ORG_ID, null, {
    displayName: "Fence Test Customer",
    countryCode: COUNTRY,
    defaultCurrency: CURRENCY,
    billingRegion: null,
    billingCountryCode: COUNTRY,
    paymentTermsDays: 30,
  });

  /**
   * Two drafts, deliberately identical apart from their ids. The whole point is
   * that the only thing distinguishing these two commands is the route param —
   * if the invoices differed in any way that reached the request, the test could
   * pass on that difference instead.
   */
  const draft = (description: string) =>
    documents.createInvoice(ORG_ID, null, {
      partyId: party.id,
      issueDate: ISSUE_DATE,
      lines: [
        {
          description,
          quantityMilli: 1000,
          unitPriceMinor: 10_000,
        },
      ],
    });

  invoiceA = (await draft("Invoice A")).id;
  invoiceB = (await draft("Invoice B")).id;
}, 900_000);

/**
 * Cleanup retries, and the reason is worth stating.
 *
 * `cleanupSeedOrgs` deletes the organisation and leans on `ON DELETE CASCADE`.
 * Nine tables reference `organizations` without cascading, and `audit_logs` is
 * the one this suite populates: posting an invoice writes an audit row. This is
 * the first fixture in its neighbourhood that performs a real business action
 * rather than asserting a guard verdict, so it is the first one the plain
 * cleanup cannot finish — and it failed the whole suite from `afterAll`, after
 * all four cases had already passed, which reads as a broken test rather than a
 * fixture that left rows behind.
 *
 * Deleting the audit rows once is not enough either. The audit write is
 * dispatched after the request's transaction commits, so a row can land *after*
 * a delete that ran a moment earlier — the first attempt at this fix removed
 * two rows and was then blocked by a third. Hence the retry: drain, delete,
 * and only then drop the organisation.
 */
async function cleanupOrg(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await db.delete(auditLogs).where(eq(auditLogs.orgId, ORG_ID));
      await cleanupSeedOrgs(db, [ORG_ID]);
      await cleanupSeedUsers(db, [USER_ID]);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

afterAll(async () => {
  if (db) await cleanupOrg();
  await app?.close();
});

/**
 * The four cases are one scenario in sequence and share `shared-session-key`
 * deliberately — the subject is what the *second* request sees of the first, so
 * there is nothing to assert until a fence exists. They are separate `it`s
 * rather than one long case so that a failure names which step broke.
 */
describe("POST /accounting/ar/invoices/:invoiceId/post — one key, two invoices", () => {
  it("posts the first invoice and stores the fence against that command", async () => {
    const key = "shared-session-key";

    const res = await post(invoiceA, key);

    expect(res.status).toBe(200);
    const journal = payload(res)["journal"] as Record<string, unknown> | undefined;
    expect(journal).toBeDefined();
    /** The first post is a real post, not a replay of something earlier. */
    expect(journal?.["replayed"]).not.toBe(true);

    await awaitCompletedFence(key);

    const fences = await fencesFor(key);
    expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({
      commandName: "accounting.ar.invoice.post",
      status: "COMPLETED",
      responseStatus: 200,
    });

    const a = await documentStatus(invoiceA);
    expect(a?.status).toBe("POSTED");
    expect(a?.journalId).not.toBeNull();
  });

  /**
   * The case the fix exists for.
   *
   * Same key, same command, same empty body — only the route param differs. With
   * the params out of the hash this returned **200 and invoice A's journal**,
   * and the caller had no way to tell it had been handed the wrong document's
   * receipt.
   */
  it("refuses the second invoice under the first invoice's key", async () => {
    const key = "shared-session-key";
    const aBefore = await documentStatus(invoiceA);

    const res = await post(invoiceB, key);

    expect(res.status).toBe(422);

    /**
     * The harm, asserted rather than described. Under the bug the caller saw a
     * 200 while both of these were still true: invoice B never posted, and the
     * journal it was shown belonged to invoice A.
     */
    const b = await documentStatus(invoiceB);
    expect(b?.status).toBe("DRAFT");
    expect(b?.journalId).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(String(aBefore?.journalId));

    /** One key is still one fence row; the refusal did not claim a second. */
    expect(await fencesFor(key)).toHaveLength(1);
  });

  /**
   * The control, and the reason the 422 above means what it claims.
   *
   * A fence that had simply started refusing everything would satisfy the case
   * above just as well. Re-sending the *original* request under the same key
   * must still replay — same params, same command, so the same hash — and the
   * caller gets invoice A's journal back rather than a second posting.
   */
  it("still replays a genuine retry of the first invoice", async () => {
    const key = "shared-session-key";

    const res = await post(invoiceA, key);

    expect(res.status).toBe(200);
    const journal = payload(res)["journal"] as Record<string, unknown> | undefined;
    const a = await documentStatus(invoiceA);
    expect(journal?.["id"]).toBe(a?.journalId);
    expect(await fencesFor(key)).toHaveLength(1);
  });

  /**
   * And the second invoice is postable all along — it was only ever the reused
   * key that stopped it. Without this, "B is still DRAFT" above would be equally
   * consistent with B being unpostable for some unrelated reason, which would
   * make the whole file vacuous.
   */
  it("posts the second invoice under its own key", async () => {
    const res = await post(invoiceB, "its-own-key");

    expect(res.status).toBe(200);
    const b = await documentStatus(invoiceB);
    expect(b?.status).toBe("POSTED");
    expect(b?.journalId).not.toBeNull();

    const a = await documentStatus(invoiceA);
    expect(b?.journalId).not.toBe(a?.journalId);
  });
});
