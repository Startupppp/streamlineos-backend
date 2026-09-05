import { eq } from "drizzle-orm";
import request from "supertest";
import { journalEntries, ledgerAccounts } from "src/db/schema";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

describe("[seeded-e2e] Accounting ledger — isolation, composite uniqueness, conflict and soft-delete", () => {
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
        permissionKeys: [
          "accounting:journal:read",
          "accounting:journal:manage",
          "accounting:accounts:read",
          "accounting:accounts:create",
          "accounting:accounts:update",
        ],
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

  it("COMPOSITE UNIQUENESS — the same account code may exist in two different organisations without violating the unique constraint", async () => {
    const sharedCode = "SPEC-COMP-CROSS-ORG";

    await seeded.seedDb.insert(ledgerAccounts).values({
      orgId: home.orgId,
      code: sharedCode,
      name: "home composite account",
      accountType: "ASSET",
    });

    await seeded.seedDb.insert(ledgerAccounts).values({
      orgId: neighbour.orgId,
      code: sharedCode,
      name: "neighbour composite account",
      accountType: "ASSET",
    });

    const rows = await seeded.seedDb
      .select({ orgId: ledgerAccounts.orgId })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.code, sharedCode));

    const orgIds = rows.map((r) => r.orgId);
    expect(orgIds).toContain(home.orgId);
    expect(orgIds).toContain(neighbour.orgId);
    expect(orgIds).toHaveLength(2);
  });

  it("CONFLICT → 409 — creating the same account code twice within one org surfaces as HTTP 409, not 500", async () => {
    const code = `SPEC-CONFLICT-${home.orgId.slice(0, 8)}`;

    const first = await request(server as never)
      .post("/accounting/accounts")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ code, name: "first account", accountType: "ASSET" });

    expect(first.status).toBe(201);

    const second = await request(server as never)
      .post("/accounting/accounts")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ code, name: "duplicate account", accountType: "ASSET" });

    expect(second.status).toBe(409);
  });

  it("SOFT-DELETE EXCLUDED — a deactivated ledger account does not appear in the activeOnly list", async () => {
    const code = `SPEC-INACTIVE-${home.orgId.slice(0, 8)}`;

    const createResp = await request(server as never)
      .post("/accounting/accounts")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ code, name: "to be deactivated", accountType: "ASSET" });

    expect(createResp.status).toBe(201);
    const accountId: unknown = createResp.body?.id;
    expect(typeof accountId).toBe("number");

    const patchResp = await request(server as never)
      .patch(`/accounting/accounts/${String(accountId)}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ isActive: false });

    expect(patchResp.status).toBe(200);

    const listResp = await request(server as never)
      .get("/accounting/accounts?activeOnly=true")
      .set("Authorization", `Bearer ${managerToken}`);

    expect(listResp.status).toBe(200);

    const body: unknown = listResp.body;
    const items = Array.isArray(body) ? body : (listResp.body.data ?? []);
    expect(
      items.some(
        (a: Record<string, unknown>) => a["code"] === code,
      ),
    ).toBe(false);
  });
});
