import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import * as schema from "src/db/schema";
import { aiCreditReservations, aiCreditTransactions, orgAiCredits } from "src/db/schema";
import type { Db } from "src/db/drizzle.module";
import { AiCreditsReservationService } from "src/modules/billing/core/ai-credits-reservation.service";
import { TRIAL_GRANT_MILLI } from "src/modules/billing/core/ai-credit-units";
import { assertDisposableDatabase } from "test/helpers/disposable-database";

/**
 * The first AI call an organisation ever makes creates its wallet. Two of them
 * arriving together used to both find no row, both INSERT, and the loser took a
 * raw 23505 out through the streaming gateway as a 500 — `SELECT … FOR UPDATE`
 * locks nothing when there is no row to lock.
 *
 * A mock cannot show this: the interleaving only exists inside a real database.
 * The barrier below is a third session holding an EXCLUSIVE table lock, which
 * conflicts with the ROW SHARE that `FOR UPDATE` takes, so both reservations are
 * held at the wallet read and released into the window together. Without it the
 * test would pass on timing rather than on behaviour.
 */
const ORG_ID = "org-reserve-race";
const OWNER_ID = "user-reserve-race";
const RESERVE_MILLI = 1_000;

const DATABASE_URL = process.env.DATABASE_URL ?? "";

describe("AiCreditsReservationService — concurrent first use of an organisation", () => {
  let client: ReturnType<typeof postgres>;
  let barrierClient: ReturnType<typeof postgres>;
  let observerClient: ReturnType<typeof postgres>;
  let db: Db;
  let svc: AiCreditsReservationService;

  beforeAll(async () => {
    const target = assertDisposableDatabase(DATABASE_URL);
    if (!target.ok) throw new Error(`[reserve-race] ${target.reason}`);

    client = postgres(DATABASE_URL, { prepare: false, max: 8 });
    barrierClient = postgres(DATABASE_URL, { prepare: false, max: 1 });
    observerClient = postgres(DATABASE_URL, { prepare: false, max: 1 });
    db = drizzle(client, { schema });
    svc = new AiCreditsReservationService(db);

    await client.begin(async (tx) => {
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`INSERT INTO users (id, email) VALUES (${OWNER_ID}, ${`${OWNER_ID}@example.test`})
               ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO organizations (id, name, slug, owner_membership_id)
               VALUES (${ORG_ID}, 'Reserve Race Org', ${ORG_ID}, 900001)
               ON CONFLICT (id) DO NOTHING`;
      await tx`INSERT INTO organization_members (id, user_id, org_id, is_owner)
               VALUES (900001, ${OWNER_ID}, ${ORG_ID}, true)
               ON CONFLICT (id) DO NOTHING`;
    });
  });

  afterAll(async () => {
    await client`DELETE FROM ai_credit_reservations WHERE org_id = ${ORG_ID}`;
    await client`DELETE FROM ai_credit_transactions WHERE org_id = ${ORG_ID}`;
    await client`DELETE FROM org_ai_credits WHERE org_id = ${ORG_ID}`;
    await client`DELETE FROM organizations WHERE id = ${ORG_ID}`;
    await client`DELETE FROM organization_members WHERE org_id = ${ORG_ID}`;
    await client`DELETE FROM users WHERE id = ${OWNER_ID}`;
    await Promise.all([
      client.end({ timeout: 5 }),
      barrierClient.end({ timeout: 5 }),
      observerClient.end({ timeout: 5 }),
    ]);
  });

  beforeEach(async () => {
    await client`DELETE FROM ai_credit_reservations WHERE org_id = ${ORG_ID}`;
    await client`DELETE FROM ai_credit_transactions WHERE org_id = ${ORG_ID}`;
    await client`DELETE FROM org_ai_credits WHERE org_id = ${ORG_ID}`;
  });

  /**
   * Holds every caller at the wallet read until they are all there. The lock has
   * to be granted BEFORE the reservations start, or they sail past it and the
   * test measures scheduling luck instead of the race.
   */
  async function raceAtTheWallet<T>(
    expectedWaiters: number,
    start: () => Promise<T>[],
  ): Promise<{ blocked: number; results: T[] }> {
    let lockAcquired: () => void = () => undefined;
    let releaseLock: () => void = () => undefined;
    const granted = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const releaseSignal = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const barrier = barrierClient.begin(async (tx) => {
      await tx`LOCK TABLE org_ai_credits IN EXCLUSIVE MODE`;
      lockAcquired();
      await releaseSignal;
    });
    await granted;

    const started = start();
    const blocked = await waitForBlockedReaders(expectedWaiters);
    releaseLock();
    await barrier;

    return { blocked, results: await Promise.all(started) };
  }

  type Settled =
    | { status: "fulfilled"; value: { reservationId: number } }
    | { status: "rejected"; reason: unknown };

  function settledReserve(idempotencyKey?: string): Promise<Settled> {
    return svc
      .reserve({
        orgId: ORG_ID,
        userId: OWNER_ID,
        feature: "race-probe",
        credits: RESERVE_MILLI,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      })
      .then(
        (value): Settled => ({ status: "fulfilled", value }),
        (reason: unknown): Settled => ({ status: "rejected", reason }),
      );
  }

  function rejectionMessages(results: readonly Settled[]): string[] {
    return results.flatMap((r) =>
      r.status === "rejected"
        ? [r.reason instanceof Error ? r.reason.message : String(r.reason)]
        : [],
    );
  }

  async function waitForBlockedReaders(expected: number): Promise<number> {
    const deadline = Date.now() + 3_000;
    let seen = 0;
    while (Date.now() < deadline) {
      const rows = await observerClient<{ waiting: string }[]>`
        SELECT count(*)::text AS waiting
        FROM pg_locks
        WHERE relation = 'org_ai_credits'::regclass AND NOT granted`;
      seen = Number(rows[0]?.waiting ?? 0);
      if (seen >= expected) return seen;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return seen;
  }

  async function countRows(): Promise<{
    wallets: number;
    grants: number;
    reservations: number;
    balance: number | null;
  }> {
    const wallets = await client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM org_ai_credits WHERE org_id = ${ORG_ID}`;
    const grants = await client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ai_credit_transactions
      WHERE org_id = ${ORG_ID} AND type = 'PLAN_GRANT'`;
    const reservations = await client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ai_credit_reservations
      WHERE org_id = ${ORG_ID} AND status = 'RESERVED'`;
    const balance = await client<{ balance: number }[]>`
      SELECT balance FROM org_ai_credits WHERE org_id = ${ORG_ID}`;
    return {
      wallets: Number(wallets[0]?.n ?? 0),
      grants: Number(grants[0]?.n ?? 0),
      reservations: Number(reservations[0]?.n ?? 0),
      balance: balance[0]?.balance ?? null,
    };
  }

  it("admits two simultaneous first reservations, creating one wallet and one trial grant", async () => {
    const { blocked, results } = await raceAtTheWallet(2, () =>
      Array.from({ length: 2 }, () => settledReserve()),
    );

    expect(blocked).toBeGreaterThanOrEqual(2);
    expect(rejectionMessages(results)).toEqual([]);

    const counts = await countRows();
    expect(counts.wallets).toBe(1);
    expect(counts.grants).toBe(1);
    expect(counts.reservations).toBe(2);
    expect(counts.balance).toBe(TRIAL_GRANT_MILLI - 2 * RESERVE_MILLI);
  });

  it("keeps the trial grant to one row when eight first reservations arrive together", async () => {
    const { blocked, results } = await raceAtTheWallet(8, () =>
      Array.from({ length: 8 }, () => settledReserve()),
    );

    expect(blocked).toBeGreaterThanOrEqual(8);
    expect(rejectionMessages(results)).toEqual([]);

    const counts = await countRows();
    expect(counts.wallets).toBe(1);
    expect(counts.grants).toBe(1);
    expect(counts.reservations).toBe(8);
    expect(counts.balance).toBe(TRIAL_GRANT_MILLI - 8 * RESERVE_MILLI);
  });

  it("grants the trial once across a second wave that finds the wallet already there", async () => {
    await svc.reserve({
      orgId: ORG_ID,
      userId: OWNER_ID,
      feature: "race-probe",
      credits: RESERVE_MILLI,
    });

    const wave = await Promise.all(Array.from({ length: 4 }, () => settledReserve()));

    expect(rejectionMessages(wave)).toEqual([]);
    const counts = await countRows();
    expect(counts.wallets).toBe(1);
    expect(counts.grants).toBe(1);
    expect(counts.reservations).toBe(5);
    expect(counts.balance).toBe(TRIAL_GRANT_MILLI - 5 * RESERVE_MILLI);
  });

  it("still serialises the balance deduction once the wallet exists", async () => {
    await client.begin(async (tx) => {
      await tx`INSERT INTO org_ai_credits (org_id, balance, lifetime_granted)
               VALUES (${ORG_ID}, ${RESERVE_MILLI * 3}, ${RESERVE_MILLI * 3})`;
    });

    const { results } = await raceAtTheWallet(6, () =>
      Array.from({ length: 6 }, () => settledReserve()),
    );

    const admitted = results.filter((r) => r.status === "fulfilled").length;
    expect(admitted).toBe(3);
    const counts = await countRows();
    expect(counts.balance).toBe(0);
    expect(counts.reservations).toBe(3);
    expect(counts.grants).toBe(0);
  });

  it("returns the same reservation for a repeated idempotency key without a second debit", async () => {
    const key = `race-idem-${Date.now()}`;
    const { blocked, results: attempts } = await raceAtTheWallet(4, () =>
      Array.from({ length: 4 }, () => settledReserve(key)),
    );

    const ids = new Set(
      attempts.flatMap((a) => (a.status === "fulfilled" ? [a.value.reservationId] : [])),
    );
    const rows = await client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ai_credit_reservations
      WHERE org_id = ${ORG_ID} AND idempotency_key = ${key}`;

    expect(blocked).toBeGreaterThanOrEqual(4);
    expect(rejectionMessages(attempts)).toEqual([]);
    expect(Number(rows[0]?.n ?? 0)).toBe(1);
    expect(ids.size).toBe(1);
    const counts = await countRows();
    expect(counts.balance).toBe(TRIAL_GRANT_MILLI - RESERVE_MILLI);
  });

  it("leaves no orphan reservation rows behind after a settle", async () => {
    const { reservationId } = await svc.reserve({
      orgId: ORG_ID,
      userId: OWNER_ID,
      feature: "race-probe",
      credits: RESERVE_MILLI,
    });
    await svc.settle(reservationId, { orgId: ORG_ID, actualMilli: 400 });

    const [wallet] = await db
      .select()
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, ORG_ID));
    const usage = await db
      .select()
      .from(aiCreditTransactions)
      .where(and(eq(aiCreditTransactions.orgId, ORG_ID), eq(aiCreditTransactions.type, "USAGE")));
    const reservations = await db
      .select()
      .from(aiCreditReservations)
      .where(eq(aiCreditReservations.orgId, ORG_ID));

    expect(wallet?.balance).toBe(TRIAL_GRANT_MILLI - 400);
    expect(wallet?.lifetimeConsumed).toBe(400);
    expect(usage).toHaveLength(1);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe("SETTLED");
  });
});
