import { and, eq, sql } from "drizzle-orm";
import {
  aiCreditPacks,
  aiCreditTransactions,
  coupons,
  orgAiCredits,
  orgEntitlementOverrides,
} from "src/db/schema";
import { AiCreditsService } from "src/modules/billing/core/ai-credits.service";
import { VersionedCatalogService } from "src/modules/billing/core/versioned-catalog.service";
import { runWithTenantContext, withTenant } from "src/common/tenant";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";
import request from "supertest";

/**
 * Credit grants and coupon codes, colliding against the real indexes.
 *
 * All four AI-credit handlers here read `err.code` off the value Drizzle threw,
 * which is a `DrizzleQueryError` carrying the SQLSTATE on `.cause`. None of
 * them fired. Two of them are the *idempotency* of a money movement — a plan
 * grant replayed by the billing cron, a payment webhook redelivered — so a dead
 * handler did not merely lose a 409: it turned "already recorded, do nothing"
 * into a 500 that the sender retries.
 *
 * Every case below performs a real duplicate write. Each service call runs in
 * its own `withTenant` transaction rather than sharing one, because a unique
 * violation aborts the transaction it happens in — recovery paths that read the
 * winner's row after catching would then die 25P02 and the spec would prove
 * nothing about the handler.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=billing-conflicts
 */
describe(`${SEEDED_HARNESS} a replayed credit grant is a no-op, not a 500`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let credits: AiCreditsService;
  let catalog: VersionedCatalogService;
  let orgId = "";
  let token = "";
  let packId = 0;
  const couponCode = `DEADCATCH${Date.now().toString().slice(-8)}`;

  const api = () => request(seeded.app.getHttpServer());

  /**
   * A service call under its own tenant transaction.
   *
   * The services reach `this.db`, which is a proxy resolving to the ambient
   * tenant transaction; with no ambient context it falls back to the raw pool
   * and every RLS-covered read fails closed with 42501. Both halves are
   * required and `withTenant` alone is not enough — it opens the transaction
   * and sets the GUCs, but only `runWithTenantContext` puts that transaction
   * where the proxy looks for it. `TenantContextInterceptor` does exactly this
   * pair for every request; a spec calling a service directly has to as well.
   */
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    withTenant(seeded.seedDb, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext(
        { orgId, audience: "INTERNAL", tx, afterCommit: [] },
        fn,
      ),
    );

  const planGrants = async () =>
    seeded.seedDb
      .select({ id: aiCreditTransactions.id })
      .from(aiCreditTransactions)
      .where(
        and(
          eq(aiCreditTransactions.orgId, orgId),
          eq(aiCreditTransactions.type, "PLAN_GRANT"),
        ),
      );

  const balance = async () => {
    const [wallet] = await seeded.seedDb
      .select({ balance: orgAiCredits.balance })
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId));
    return wallet?.balance ?? 0;
  };

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      /**
       * Standing OWNER, not a permission grant. Platform billing is never
       * delegated — `assertPermissionsGrantable` refuses the whole `billing:`
       * namespace on every grant path — so a seeded `billing:coupons:manage`
       * row does not produce a caller who can reach the route, and the request
       * answers 403 instead of the conflict under test.
       */
      .addMember("admin", { standing: "OWNER" })
      .build();
    orgId = fixture.orgId;
    token = await signSeededToken(seeded, fixture.members["admin"]!.userId, orgId);
    credits = seeded.app.get(AiCreditsService);
    catalog = seeded.app.get(VersionedCatalogService);

    const [pack] = await seeded.seedDb
      .insert(aiCreditPacks)
      .values({
        name: `deadcatch-pack-${orgId.slice(0, 8)}`,
        credits: 500,
        bonusCredits: 0,
        priceInPaise: 10000,
        isActive: true,
      })
      .returning({ id: aiCreditPacks.id });
    packId = pack!.id;
  }, 120000);

  afterAll(async () => {
    await seeded.seedDb.delete(coupons).where(eq(coupons.code, couponCode));
    await seeded.seedDb
      .delete(orgEntitlementOverrides)
      .where(eq(orgEntitlementOverrides.orgId, orgId));
    await seeded.seedDb.delete(aiCreditPacks).where(eq(aiCreditPacks.id, packId));
    await fixture.teardown();
    await seeded.close();
  });

  /**
   * `uq_ai_credit_txns_plan_grant_ref` — (org_id, reference_id) WHERE
   * type = 'PLAN_GRANT' AND reference_id IS NOT NULL.
   *
   * No `referenceId` argument on purpose: that is how `BillingPaymentActivation`
   * activates a plan, and it is the shape that skips the `if (referenceId)`
   * pre-check entirely while still writing `referenceId ?? plan` into the row.
   * So the second grant reaches the index rather than the pre-check, and the
   * index is the only thing standing between a retried activation and a second
   * free grant of the plan's credits.
   */
  it("credits a plan grant once, however many times it is replayed", async () => {
    await inTenant(() => credits.grantPlanCredits(orgId, "STARTER"));
    const afterFirst = await balance();
    expect(afterFirst).toBeGreaterThan(0);
    expect(await planGrants()).toHaveLength(1);

    await expect(
      inTenant(() => credits.grantPlanCredits(orgId, "STARTER")),
    ).resolves.toBeUndefined();

    expect(await planGrants()).toHaveLength(1);
    expect(await balance()).toBe(afterFirst);
  });

  /**
   * `uq_ai_credit_txns_purchase_ref` — (org_id, reference_id) WHERE
   * type = 'PURCHASE'. The `automatic` pre-check does not run for a manual
   * purchase, so a redelivered payment reference reaches the index.
   */
  it("credits a repeated payment reference once, and still answers the caller", async () => {
    const before = await balance();

    const first = await inTenant(() =>
      credits.purchaseCreditsDirectly(orgId, null, packId, false, "pay_dead_catch"),
    );
    expect(first.creditsAdded).toBe(500);
    const afterFirst = await balance();
    expect(afterFirst).toBe(before + 500_000);

    const replay = await inTenant(() =>
      credits.purchaseCreditsDirectly(orgId, null, packId, false, "pay_dead_catch"),
    );
    expect(replay.creditsAdded).toBe(500);
    expect(await balance()).toBe(afterFirst);
  });

  /**
   * The webhook leg. Same index, and the one where a 500 is worst: a provider
   * that gets one retries, and every retry used to 500 again.
   */
  it("credits a redelivered webhook payment once", async () => {
    const before = await balance();

    await inTenant(() => credits.grantAiPackCreditsFromWebhook(orgId, packId, "pay_webhook_dead"));
    const afterFirst = await balance();
    expect(afterFirst).toBe(before + 500_000);

    await expect(
      inTenant(() => credits.grantAiPackCreditsFromWebhook(orgId, packId, "pay_webhook_dead")),
    ).resolves.toBeUndefined();
    expect(await balance()).toBe(afterFirst);
  });

  /** `coupons.code` is unique platform-wide and the caller supplies it. */
  it("refuses a second coupon with the same code, and names it", async () => {
    const create = () =>
      api()
        .post("/billing/coupons")
        .set("Authorization", `Bearer ${token}`)
        .send({ code: couponCode, type: "PERCENTAGE", value: 10 });

    const first = await create();
    expect(first.status).toBe(201);

    const second = await create();
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain(
      `A coupon with the code ${couponCode.toUpperCase()} already exists`,
    );
  });

  /**
   * The entitlement override upsert, which could not reach its own conflict
   * handler at all.
   *
   * `uq_org_ent_overrides_idem` is a PARTIAL unique index, and the statement's
   * conflict target did not repeat the predicate — the predicate was on
   * `setWhere`, which renders after `DO UPDATE SET` and tells arbiter
   * inference nothing. Postgres therefore refused the statement outright with
   * 42P10 on every call, conflict or not, so the 23505 handler underneath was
   * dead three times over. The service's only other spec mocks the insert
   * chain, so nothing executed this against a database until now.
   *
   * There is no production caller for this method today; that is reported, not
   * fixed here.
   */
  it("upserts an entitlement override, and replays the same idempotency key", async () => {
    const actorId = fixture.members["admin"]!.userId;

    await expect(
      inTenant(() =>
        catalog.upsertOrgEntitlementOverride(orgId, "seats", 25, actorId, "negotiated", "idem-1"),
      ),
    ).resolves.toBeUndefined();

    await expect(
      inTenant(() =>
        catalog.upsertOrgEntitlementOverride(orgId, "seats", 40, actorId, "renegotiated", "idem-1"),
      ),
    ).resolves.toBeUndefined();

    const rows = await seeded.seedDb
      .select({
        featureKey: orgEntitlementOverrides.featureKey,
        limitValue: orgEntitlementOverrides.limitValue,
      })
      .from(orgEntitlementOverrides)
      .where(eq(orgEntitlementOverrides.orgId, orgId));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.limitValue).toBe(40);
  });

  /**
   * `getWallet`'s handler is the one collision here that only a race can
   * produce: both callers find no wallet, both insert, and
   * `org_ai_credits.org_id` lets exactly one through. Two concurrent calls on
   * separate connections reproduce it often but not deterministically, so what
   * is asserted is the invariant rather than which call lost: one wallet row,
   * no thrown error. Before the fix the loser propagated a DrizzleQueryError.
   */
  it("survives two callers creating the same wallet at once", async () => {
    await seeded.seedDb.delete(aiCreditTransactions).where(eq(aiCreditTransactions.orgId, orgId));
    await seeded.seedDb.delete(orgAiCredits).where(eq(orgAiCredits.orgId, orgId));

    const results = await Promise.allSettled([
      inTenant(() => credits.getWallet(orgId)),
      inTenant(() => credits.getWallet(orgId)),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    const [{ count }] = await seeded.seedDb
      .select({ count: sql<number>`count(*)::int` })
      .from(orgAiCredits)
      .where(eq(orgAiCredits.orgId, orgId));
    expect(count).toBe(1);
  });
});
