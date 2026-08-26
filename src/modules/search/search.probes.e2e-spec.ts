import { sql } from "drizzle-orm";
import type { Db } from "src/db/drizzle.module";
import { DRIZZLE } from "src/db/drizzle.constants";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

type Row = Record<string, unknown>;

async function callProbeInTx(
  db: Db,
  orgId: string,
  fnCall: string,
): Promise<Row[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.organization_id', ${orgId}, true)`);
    return tx.execute(sql.raw(`SELECT id FROM (${fnCall}) AS t(id)`)) as Promise<Row[]>;
  });
}

describe(`${SEEDED_HARNESS} search id-probe isolation`, () => {
  let seededApp: SeededE2eApp;
  let appDb: Db;
  let seedDb: Db;

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
    appDb = seededApp.app.get<Db>(DRIZZLE);
    seedDb = seededApp.seedDb;
  }, 120_000);

  afterAll(async () => {
    await seededApp.close();
  });

  describe("app.search_lead_party_ids", () => {
    let fixtureA: SeededFixture;
    let fixtureB: SeededFixture;
    let partyA: string;
    let partyB: string;
    const termLead = `probelead${Date.now()}`;

    beforeAll(async () => {
      fixtureA = await seedOrg(seedDb).build();
      fixtureB = await seedOrg(seedDb).build();
      partyA = `plid-a-${crypto.randomUUID()}`;
      partyB = `plid-b-${crypto.randomUUID()}`;

      await seedDb.execute(sql`
        INSERT INTO business_parties (party_id, organization_id, name, deleted_at)
        VALUES
          (${partyA}, ${fixtureA.orgId}, ${termLead}, NULL),
          (${partyB}, ${fixtureB.orgId}, ${termLead}, NULL)
      `);
    }, 60_000);

    afterAll(async () => {
      await Promise.all([fixtureA.teardown(), fixtureB.teardown()]);
    });

    it("returns only the calling org's party ids", async () => {
      const rowsA = await callProbeInTx(
        appDb,
        fixtureA.orgId,
        `SELECT app.search_lead_party_ids('${termLead}', 10)`,
      );
      const idsA = rowsA.map((r) => String(r["id"]));
      expect(idsA).toContain(partyA);
      expect(idsA).not.toContain(partyB);
    }, 30_000);

    it("does not cross into the other org", async () => {
      const rowsB = await callProbeInTx(
        appDb,
        fixtureB.orgId,
        `SELECT app.search_lead_party_ids('${termLead}', 10)`,
      );
      const idsB = rowsB.map((r) => String(r["id"]));
      expect(idsB).toContain(partyB);
      expect(idsB).not.toContain(partyA);
    }, 30_000);

    it("fails closed when no tenant GUC is set", async () => {
      const err = await appDb
        .execute(sql.raw(`SELECT app.search_lead_party_ids('${termLead}', 10)`))
        .then(
          () => null,
          (e: unknown) => e,
        );
      const cause = err instanceof Error ? (err.cause ?? err) : err;
      expect(cause).toMatchObject({ code: "42501" });
    }, 30_000);
  });

  describe("app.search_deal_ids", () => {
    let fixtureA: SeededFixture;
    let fixtureB: SeededFixture;
    let dealIdA: number;
    let dealIdB: number;
    const termDeal = `probedeal${Date.now()}`;

    beforeAll(async () => {
      fixtureA = await seedOrg(seedDb).build();
      fixtureB = await seedOrg(seedDb).build();

      const rowsA = await seedDb.execute(sql`
        INSERT INTO deals (org_id, name) VALUES (${fixtureA.orgId}, ${termDeal}) RETURNING id
      `);
      const rowsB = await seedDb.execute(sql`
        INSERT INTO deals (org_id, name) VALUES (${fixtureB.orgId}, ${termDeal}) RETURNING id
      `);
      dealIdA = Number(rowsA[0]?.["id"]);
      dealIdB = Number(rowsB[0]?.["id"]);
    }, 60_000);

    afterAll(async () => {
      await Promise.all([fixtureA.teardown(), fixtureB.teardown()]);
    });

    it("returns only the calling org's deal ids", async () => {
      const rowsA = await callProbeInTx(
        appDb,
        fixtureA.orgId,
        `SELECT app.search_deal_ids('${termDeal}', 10)`,
      );
      const idsA = rowsA.map((r) => Number(r["id"]));
      expect(idsA).toContain(dealIdA);
      expect(idsA).not.toContain(dealIdB);
    }, 30_000);

    it("does not cross into the other org", async () => {
      const rowsB = await callProbeInTx(
        appDb,
        fixtureB.orgId,
        `SELECT app.search_deal_ids('${termDeal}', 10)`,
      );
      const idsB = rowsB.map((r) => Number(r["id"]));
      expect(idsB).toContain(dealIdB);
      expect(idsB).not.toContain(dealIdA);
    }, 30_000);

    it("fails closed when no tenant GUC is set", async () => {
      const err = await appDb
        .execute(sql.raw(`SELECT app.search_deal_ids('${termDeal}', 10)`))
        .then(
          () => null,
          (e: unknown) => e,
        );
      const cause = err instanceof Error ? (err.cause ?? err) : err;
      expect(cause).toMatchObject({ code: "42501" });
    }, 30_000);
  });

  describe("app.search_contact_party_ids", () => {
    let fixtureA: SeededFixture;
    let fixtureB: SeededFixture;
    let partyA: string;
    let partyB: string;
    const termContact = `probecontact${Date.now()}`;

    beforeAll(async () => {
      fixtureA = await seedOrg(seedDb).build();
      fixtureB = await seedOrg(seedDb).build();
      partyA = `cpid-a-${crypto.randomUUID()}`;
      partyB = `cpid-b-${crypto.randomUUID()}`;

      await seedDb.execute(sql`
        INSERT INTO business_parties (party_id, organization_id, name, deleted_at)
        VALUES
          (${partyA}, ${fixtureA.orgId}, ${termContact}, NULL),
          (${partyB}, ${fixtureB.orgId}, ${termContact}, NULL)
      `);
    }, 60_000);

    afterAll(async () => {
      await Promise.all([fixtureA.teardown(), fixtureB.teardown()]);
    });

    it("returns only the calling org's contact party ids", async () => {
      const rowsA = await callProbeInTx(
        appDb,
        fixtureA.orgId,
        `SELECT app.search_contact_party_ids('${termContact}', 10)`,
      );
      const idsA = rowsA.map((r) => String(r["id"]));
      expect(idsA).toContain(partyA);
      expect(idsA).not.toContain(partyB);
    }, 30_000);

    it("does not cross into the other org", async () => {
      const rowsB = await callProbeInTx(
        appDb,
        fixtureB.orgId,
        `SELECT app.search_contact_party_ids('${termContact}', 10)`,
      );
      const idsB = rowsB.map((r) => String(r["id"]));
      expect(idsB).toContain(partyB);
      expect(idsB).not.toContain(partyA);
    }, 30_000);

    it("fails closed when no tenant GUC is set", async () => {
      const err = await appDb
        .execute(sql.raw(`SELECT app.search_contact_party_ids('${termContact}', 10)`))
        .then(
          () => null,
          (e: unknown) => e,
        );
      const cause = err instanceof Error ? (err.cause ?? err) : err;
      expect(cause).toMatchObject({ code: "42501" });
    }, 30_000);
  });

  describe("app.search_client_party_ids", () => {
    let fixtureA: SeededFixture;
    let fixtureB: SeededFixture;
    let partyA: string;
    let partyB: string;
    const termClient = `probeclient${Date.now()}`;

    beforeAll(async () => {
      fixtureA = await seedOrg(seedDb).build();
      fixtureB = await seedOrg(seedDb).build();
      partyA = `clpid-a-${crypto.randomUUID()}`;
      partyB = `clpid-b-${crypto.randomUUID()}`;

      await seedDb.execute(sql`
        INSERT INTO business_parties (party_id, organization_id, name, deleted_at)
        VALUES
          (${partyA}, ${fixtureA.orgId}, ${termClient}, NULL),
          (${partyB}, ${fixtureB.orgId}, ${termClient}, NULL)
      `);
    }, 60_000);

    afterAll(async () => {
      await Promise.all([fixtureA.teardown(), fixtureB.teardown()]);
    });

    it("returns only the calling org's client party ids", async () => {
      const rowsA = await callProbeInTx(
        appDb,
        fixtureA.orgId,
        `SELECT app.search_client_party_ids('${termClient}', 10)`,
      );
      const idsA = rowsA.map((r) => String(r["id"]));
      expect(idsA).toContain(partyA);
      expect(idsA).not.toContain(partyB);
    }, 30_000);

    it("does not cross into the other org", async () => {
      const rowsB = await callProbeInTx(
        appDb,
        fixtureB.orgId,
        `SELECT app.search_client_party_ids('${termClient}', 10)`,
      );
      const idsB = rowsB.map((r) => String(r["id"]));
      expect(idsB).toContain(partyB);
      expect(idsB).not.toContain(partyA);
    }, 30_000);

    it("fails closed when no tenant GUC is set", async () => {
      const err = await appDb
        .execute(sql.raw(`SELECT app.search_client_party_ids('${termClient}', 10)`))
        .then(
          () => null,
          (e: unknown) => e,
        );
      const cause = err instanceof Error ? (err.cause ?? err) : err;
      expect(cause).toMatchObject({ code: "42501" });
    }, 30_000);
  });
});
