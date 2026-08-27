/**
 * Real-database proof that the demo dataset does not count as the tenant's data.
 *
 * A mocked database answers whatever it was told to answer, so it cannot show
 * that `IS DISTINCT FROM` behaves on a NULL `acquisition_source`, or that the
 * semi-join finding demo deals through their party matches every seeded deal and
 * no real one. Those are the two places this can silently be wrong, and being
 * wrong means the funnel reports every workspace as activated on day one.
 *
 * Guarded by CRM_DB_TESTS=1 so the default hermetic run is unaffected. Run with:
 *   CRM_DB_TESTS=1 npx jest --runInBand --testPathPattern="activation-demo-exclusion"
 *
 * Everything happens inside one transaction that is rolled back, so the database
 * is left exactly as it was found. Counts are compared as deltas against an
 * existing organisation rather than in absolute terms, so the test needs no
 * fixture organisation and cannot be thrown off by whatever that organisation
 * already holds.
 */
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { TransactionRollbackError, and, eq, sql as raw } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { activities, businessParties, deals } from "../../db/schema";
import { ActivationService } from "./activation.service";
import { seedDemoDataset } from "./seed-demo-dataset";
import { DEMO_SOURCE, demoDataset } from "./demo-dataset";

/**
 * The transaction handle, spelled through the driver rather than by naming
 * drizzle's generics: writing them out makes the checker chase a type deep
 * enough to give up ("excessively deep and possibly infinite").
 */
type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

const ENABLED = process.env.CRM_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for CRM_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

describeDb("activation counts the tenant's data, not ours", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = connect();
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  async function inTransaction(
    body: (context: {
      activation: ActivationService;
      db: Tx;
      orgId: string;
      userId: string;
    }) => Promise<void>,
  ): Promise<void> {
    const db = drizzle(sql);

    const run = db.transaction(async (tx) => {
      await tx.execute(raw`SET LOCAL statement_timeout = '60s'`);

      const members = await tx.execute(
        raw`SELECT org_id, user_id FROM organization_members WHERE left_at IS NULL LIMIT 1`,
      );
      const member = members[0];
      if (!member) throw new Error("no organisation to test against");

      await body({
        activation: new ActivationService(tx as never),
        db: tx,
        orgId: String(member["org_id"]),
        userId: String(member["user_id"]),
      });

      // Everything above is a fixture. Rolling back is what lets this run
      // against a live database without leaving a demo dataset in somebody's
      // real workspace.
      tx.rollback();
    });

    // `tx.rollback()` signals the rollback by throwing, and the postgres-js
    // driver lets that out rather than swallowing it. Catching only this one
    // means a genuine failure inside the body still fails the test.
    await run.catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error;
    });
  }

  it("does not move a single record signal when the demo dataset lands", async () => {
    await inTransaction(async ({ activation, db, orgId, userId }) => {
      const before = (await activation.report(orgId)).signals;

      const result = await seedDemoDataset(db as never, orgId, userId);
      expect(result.seeded).toBe(true);

      const after = (await activation.report(orgId)).signals;

      expect(after.realParties).toBe(before.realParties);
      expect(after.realDeals).toBe(before.realDeals);
      expect(after.realActivities).toBe(before.realActivities);
    });
  });

  it("still counts the tenant's own records, so the exclusion is not just a filter that eats everything", async () => {
    await inTransaction(async ({ activation, db, orgId, userId }) => {
      await seedDemoDataset(db as never, orgId, userId);
      const withDemo = (await activation.report(orgId)).signals;

      const partyId = randomUUID();
      await db.insert(businessParties).values({
        partyId,
        organizationId: orgId,
        name: "A customer they actually have",
        partyKind: "ORGANISATION",
      });
      const [deal] = await db
        .insert(deals)
        .values({ orgId, name: "A deal they actually opened", partyId })
        .returning({ id: deals.id });
      await db.insert(activities).values({
        organizationId: orgId,
        kind: "note",
        partyId,
        actorKind: "human",
        actorUserId: userId,
        subject: "Something they actually wrote",
      });

      expect(deal).toBeDefined();

      const withTheirs = (await activation.report(orgId)).signals;

      expect(withTheirs.realParties).toBe(withDemo.realParties + 1);
      expect(withTheirs.realDeals).toBe(withDemo.realDeals + 1);
      expect(withTheirs.realActivities).toBe(withDemo.realActivities + 1);
    });
  });

  it("does leave something in the workspace, which is the point of seeding one", async () => {
    await inTransaction(async ({ db, orgId, userId }) => {
      const dataset = demoDataset();
      await seedDemoDataset(db as never, orgId, userId);

      const parties = await db
        .select({ partyId: businessParties.partyId })
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, orgId),
            eq(businessParties.acquisitionSource, DEMO_SOURCE),
          ),
        );

      expect(parties).toHaveLength(dataset.parties.length);
    });
  });

  it("seeds once, however many times a claim is retried", async () => {
    await inTransaction(async ({ activation, db, orgId, userId }) => {
      await seedDemoDataset(db as never, orgId, userId);
      const afterFirst = (await activation.report(orgId)).signals;

      const second = await seedDemoDataset(db as never, orgId, userId);
      const afterSecond = (await activation.report(orgId)).signals;

      expect(second.seeded).toBe(false);
      expect(afterSecond).toEqual(afterFirst);
    });
  });
});
