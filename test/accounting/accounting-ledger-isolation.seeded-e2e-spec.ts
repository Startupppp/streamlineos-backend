import { eq } from "drizzle-orm";
import request from "supertest";
import { journalEntries } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * Two seeded organisations, the real guards, the real RBAC resolver and a real
 * Postgres. The nine DB-less suites under `src/modules/accounting` mock the query
 * builder and therefore cannot assert that a cross-tenant id produces 404 rather
 * than 403 — a mocked `where` accepts any predicate.
 *
 * This file asks the question those suites cannot.
 *
 *   allow        the manager reads their own journal entry (200)
 *   cross-tenant a manager of org A asking for org B's entry id gets 404, not 403
 *                — a 403 would confirm the record exists (backend/CLAUDE.md §4)
 *   deny (RBAC)  a member holding only accounting:journal:read is refused the post
 *                action at 403 inside their own tenant; the row does not move
 *   integrity    after the cross-tenant post attempt, org B's row is re-read from
 *                the database and is still DRAFT
 *
 * WHAT THIS FILE DOES *NOT* PROVE, measured rather than assumed. The app connects
 * as APP_DATABASE_URL (streamline_app, not the table owner). If RLS is active on
 * journal_entries with a policy that filters on org_id = current_org_id(), the
 * cross-tenant 404 is enforced by Postgres independently of the service predicate
 * in AccountingLedgerService.getJournalEntry and postJournalEntry. This file
 * proves the DEPLOYED SYSTEM refuses; attribution of the cross-tenant leg to the
 * service predicate belongs to a unit test that compiles the predicate and
 * asserts the tenant binding. The RBAC leg (403 from PermissionGuard) is solely
 * attributable to the guard: narrowing the post route's @RequirePermission key
 * from "accounting:journal:manage" to "accounting:journal:read" turns the DENY
 * case red here and nowhere else.
 */
describe("[seeded-e2e] Accounting journal — allow, deny and cross-tenant isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let homeEntryId = 0;
  let neighbourEntryId = 0;
  let managerToken = "";
  let readerToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("accounting")
      .addMember("manager", {
        permissionKeys: ["accounting:journal:read", "accounting:journal:manage"],
      })
      .addMember("reader", { permissionKeys: ["accounting:journal:read"] })
      .build();

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("accounting")
      .addMember("manager", {
        permissionKeys: ["accounting:journal:read", "accounting:journal:manage"],
      })
      .build();

    const [homeRow] = await seeded.seedDb
      .insert(journalEntries)
      .values({
        orgId: home.orgId,
        entryNumber: `JE-HOME-${home.orgId.slice(0, 8)}`,
        entryDate: "2026-01-15",
        status: "DRAFT",
        sourceType: "manual",
        createdBy: home.members.manager?.userId ?? "",
        currency: "INR",
        description: "home test entry",
      })
      .returning({ id: journalEntries.id });
    homeEntryId = homeRow?.id ?? 0;

    const [neighbourRow] = await seeded.seedDb
      .insert(journalEntries)
      .values({
        orgId: neighbour.orgId,
        entryNumber: `JE-NBR-${neighbour.orgId.slice(0, 8)}`,
        entryDate: "2026-01-15",
        status: "DRAFT",
        sourceType: "manual",
        createdBy: neighbour.members.manager?.userId ?? "",
        currency: "INR",
        description: "neighbour test entry",
      })
      .returning({ id: journalEntries.id });
    neighbourEntryId = neighbourRow?.id ?? 0;

    managerToken = await signSeededToken(
      seeded,
      home.members.manager?.userId ?? "",
      home.orgId,
    );
    readerToken = await signSeededToken(
      seeded,
      home.members.reader?.userId ?? "",
      home.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (homeEntryId > 0)
      await seeded.seedDb
        .delete(journalEntries)
        .where(eq(journalEntries.id, homeEntryId));
    if (neighbourEntryId > 0)
      await seeded.seedDb
        .delete(journalEntries)
        .where(eq(journalEntries.id, neighbourEntryId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  async function statusOf(entryId: number): Promise<string | undefined> {
    const [row] = await seeded.seedDb
      .select({ status: journalEntries.status })
      .from(journalEntries)
      .where(eq(journalEntries.id, entryId));
    return row?.status;
  }

  it("fixture check — the two entries are in different organisations", () => {
    expect(homeEntryId).toBeGreaterThan(0);
    expect(neighbourEntryId).toBeGreaterThan(0);
    expect(homeEntryId).not.toBe(neighbourEntryId);
    expect(home.orgId).not.toBe(neighbour.orgId);
  });

  it("ALLOW — the home manager reads their own journal entry", async () => {
    const response = await request(server as never)
      .get(`/accounting/journal/${String(homeEntryId)}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
  });

  it("CROSS-TENANT read — the neighbour's entry id answers 404, not 403", async () => {
    const response = await request(server as never)
      .get(`/accounting/journal/${String(neighbourEntryId)}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(404);
  });

  it("DENY — a member holding only :read is refused the post at 403, and the row is untouched", async () => {
    const before = await statusOf(homeEntryId);
    const response = await request(server as never)
      .post(`/accounting/journal/${String(homeEntryId)}/post`)
      .set("Authorization", `Bearer ${readerToken}`);

    expect(response.status).toBe(403);
    expect(await statusOf(homeEntryId)).toBe(before);
  });

  it("CROSS-TENANT write — posting the neighbour's entry answers 404 and leaves their row unchanged", async () => {
    expect(await statusOf(neighbourEntryId)).toBe("DRAFT");

    const response = await request(server as never)
      .post(`/accounting/journal/${String(neighbourEntryId)}/post`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(404);
    expect(await statusOf(neighbourEntryId)).toBe("DRAFT");
  });
});
