import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  crmDealForecastModels,
  crmDealForecastScores,
  dealActivities,
  dealStageTransitions,
  deals,
  orgModules,
} from "src/db/schema";
import { ForecastTrainingService } from "src/modules/deals/forecast/forecast-training.service";
import { FORECAST_HISTORY_REQUIREMENT } from "src/modules/deals/forecast/forecast-cold-start";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * CRM-P2-03. The trainer, and the refusal that matters more than the model.
 *
 * Every piece of the learned forecast has existed for a while with nothing
 * calling it: `fitLogisticModel`, `scoreWithModel`, `acceptModel`, and both
 * forecast tables. `DealsAnalyticsService.forecastBasis` said so in its own
 * docblock — "the learned arm turns on when a trainer does, not before". This
 * exercises the trainer against a real database.
 *
 * The order of the tests is the argument. The first two prove that a workspace
 * which cannot be given a model is refused and that the refusal writes NOTHING —
 * because a trainer that stores a model it then declines to use is worse than no
 * trainer at all, and a passing test on the happy path alone would not notice.
 * Only then does the third seed a learnable pipeline and ask for a model.
 *
 * The signal seeded here is deliberately blunt: won deals are worked and
 * advanced, lost deals go quiet. That is not a claim about real pipelines; it is
 * the minimum a fourteen-feature logistic fit must be able to find before the
 * plumbing around it can be said to work at all. What is asserted is the
 * plumbing — that the fit reads the tenant's own history, that the verdict is
 * `acceptModel`'s, that an accepted model is stored active and supersedes its
 * predecessor, and that the open pipeline is scored under it.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=crm-forecast-trainer
 */

const DAY_MS = 86_400_000;
const NOW = new Date("2026-09-09T00:00:00.000Z");

describe(`${SEEDED_HARNESS} the forecast trainer refuses before it ships`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let trainer: ForecastTrainingService;

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(seeded.seedDb, fixture.orgId, () => fn());

  /**
   * One closed deal, with a ledger and a timeline that agree with its outcome.
   *
   * `closedDaysAgo` decides which side of the chronological split it lands on,
   * so wins and losses are interleaved by the caller rather than blocked — a
   * corpus ordered by outcome gives a holdout of one class and an AUC that means
   * nothing.
   */
  async function seedClosedDeal(options: {
    won: boolean;
    closedDaysAgo: number;
    activities: number;
    advanced: boolean;
  }): Promise<void> {
    const closedAt = new Date(NOW.getTime() - options.closedDaysAgo * DAY_MS);
    const createdAt = new Date(closedAt.getTime() - 120 * DAY_MS);
    const stage = options.won ? "WON" : "LOST";

    const [row] = await seeded.seedDb
      .insert(deals)
      .values({
        orgId: fixture.orgId,
        name: `closed-${randomUUID().slice(0, 8)}`,
        valueMinor: 500_000 + options.activities * 1_000,
        stage,
        probability: options.won ? 100 : 0,
        createdAt,
        updatedAt: closedAt,
        actualCloseDate: closedAt.toISOString().slice(0, 10),
        expectedCloseDate: closedAt.toISOString().slice(0, 10),
      })
      .returning({ id: deals.id });
    if (row === undefined) throw new Error("seed: deal insert returned no row");

    /**
     * The ledger, written to land BEFORE the training horizon. A move recorded
     * on the closing day is exactly the leak `trainingAsOf` exists to avoid, and
     * seeding one here would let the fixture pass a test the product would fail.
     */
    const openedAt = new Date(createdAt.getTime() + DAY_MS);
    await seeded.seedDb.insert(dealStageTransitions).values({
      organizationId: fixture.orgId,
      dealId: row.id,
      fromStage: null,
      toStage: "LEAD",
      actorKind: "system",
      actorLabel: "seed",
      occurredAt: openedAt,
    });
    if (options.advanced)
      await seeded.seedDb.insert(dealStageTransitions).values({
        organizationId: fixture.orgId,
        dealId: row.id,
        fromStage: "LEAD",
        toStage: "PROPOSAL",
        actorKind: "system",
        actorLabel: "seed",
        occurredAt: new Date(createdAt.getTime() + 40 * DAY_MS),
      });

    await seeded.seedDb.insert(dealActivities).values(
      Array.from({ length: options.activities }, (_, index) => ({
        orgId: fixture.orgId,
        dealId: row.id,
        type: "NOTE",
        subject: `touch-${index}`,
        userId: fixture.members["analyst"]!.userId,
        /** Before the horizon, so the activity count is one the model may see. */
        createdAt: new Date(createdAt.getTime() + (index + 1) * DAY_MS),
      })),
    );
  }

  async function seedOpenDeal(): Promise<number> {
    const [row] = await seeded.seedDb
      .insert(deals)
      .values({
        orgId: fixture.orgId,
        name: `open-${randomUUID().slice(0, 8)}`,
        valueMinor: 750_000,
        stage: "LEAD",
        probability: 20,
        createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
      })
      .returning({ id: deals.id });
    if (row === undefined) throw new Error("seed: open deal insert returned no row");
    return row.id;
  }

  const activeModels = () =>
    seeded.seedDb
      .select({
        modelId: crmDealForecastModels.crmDealForecastModelId,
        becameAvailableAt: crmDealForecastModels.becameAvailableAt,
        trainingDeals: crmDealForecastModels.trainingDeals,
      })
      .from(crmDealForecastModels)
      .where(
        and(
          eq(crmDealForecastModels.organizationId, fixture.orgId),
          eq(crmDealForecastModels.status, "active"),
        ),
      );

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb).addMember("analyst", { permissionKeys: [] }).build();
    trainer = seeded.app.get(ForecastTrainingService);

    /** Every CRM route and read is module-gated; without this the org 402s. */
    await seeded.seedDb
      .insert(orgModules)
      .values({ orgId: fixture.orgId, moduleKey: "crm", enabled: true })
      .onConflictDoNothing();
  }, 240_000);

  afterAll(async () => {
    if (fixture) {
      await seeded.seedDb
        .delete(crmDealForecastScores)
        .where(eq(crmDealForecastScores.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(crmDealForecastModels)
        .where(eq(crmDealForecastModels.organizationId, fixture.orgId));
      await seeded.seedDb
        .delete(dealActivities)
        .where(eq(dealActivities.orgId, fixture.orgId));
      await seeded.seedDb
        .delete(dealStageTransitions)
        .where(eq(dealStageTransitions.organizationId, fixture.orgId));
      await seeded.seedDb.delete(deals).where(eq(deals.orgId, fixture.orgId));
      await fixture.teardown();
    }
    await seeded?.close();
  }, 120_000);

  it("refuses a workspace with no closed history, and says how much is missing", async () => {
    const attempt = await asTenant(() => trainer.train(fixture.orgId, NOW));

    expect(attempt.trained).toBe(false);
    if (attempt.trained) throw new Error("unreachable");
    expect(attempt.reason).toBe("insufficient-history");
    expect(attempt.readiness.ready).toBe(false);
    /** Not "none": the shortfall is the number the surface shows. */
    expect(attempt.readiness.closedDealsNeeded).toBeGreaterThan(0);
    expect(attempt.readiness.minimumClosedDeals).toBe(
      FORECAST_HISTORY_REQUIREMENT.minClosedDeals,
    );
  }, 180_000);

  it("writes nothing at all when it refuses", async () => {
    /**
     * The test the first one is scaffolding for. A trainer that stored a model
     * and then declined to use it would pass every assertion above while leaving
     * a row that the next reader would happily score against.
     */
    const models = await activeModels();
    expect(models).toHaveLength(0);

    const scores = await seeded.seedDb
      .select({ dealId: crmDealForecastScores.dealId })
      .from(crmDealForecastScores)
      .where(eq(crmDealForecastScores.organizationId, fixture.orgId));
    expect(scores).toHaveLength(0);
  }, 120_000);

  it("still reports the naive basis, with the tenant's gap rather than ours", async () => {
    const basis = await asTenant(() => trainer.describeBasis(fixture.orgId, NOW));

    expect(basis.kind).toBe("naive-weighted");
    if (basis.kind !== "naive-weighted") throw new Error("unreachable");
    expect(basis.reason).toBe("insufficient-history");
  }, 120_000);

  it("fits and stores a model once the history is there and it beats the arithmetic", async () => {
    /**
     * Interleaved by close date, so the chronological holdout carries both
     * outcomes. Blocking wins and losses would give a holdout of one class, an
     * AUC of 0.5 by definition, and a refusal that says nothing about the fit.
     */
    for (let index = 0; index < 70; index += 1) {
      const won = index % 2 === 0;
      /**
       * 70, not 60: `FORECAST_HISTORY_REQUIREMENT` is the floor, and a corpus
       * sitting exactly on it leaves the holdout at the `minHoldoutDeals`
       * boundary where a single row decides whether the run is refused for
       * having no holdout.
       *
       * `700 - index * 9` keeps every close date inside the two-year training
       * window and in the past. Running off the end of the window would silently
       * shrink the corpus below the floor again; running into the future would
       * seed deals that closed tomorrow.
       */
      await seedClosedDeal({
        won,
        closedDaysAgo: 700 - index * 9,
        activities: won ? 8 + (index % 3) : 1,
        advanced: won,
      });
    }
    for (let index = 0; index < 3; index += 1) await seedOpenDeal();

    const attempt = await asTenant(() => trainer.train(fixture.orgId, NOW));

    expect(attempt.trained).toBe(true);
    if (!attempt.trained) throw new Error(`refused: ${attempt.reason}`);

    /** Judged only on deals it never saw, and it had to beat the naive arm. */
    expect(attempt.holdoutDeals).toBeGreaterThanOrEqual(10);
    expect(attempt.learned.auc).toBeGreaterThanOrEqual(0.6);
    expect(attempt.learned.brier).toBeLessThanOrEqual(attempt.naive.brier);
    expect(attempt.scored).toBe(3);

    const models = await activeModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.trainingDeals).toBeGreaterThan(0);
  }, 300_000);

  it("scores every open deal under that model, with the features beside the answer", async () => {
    const scores = await seeded.seedDb
      .select()
      .from(crmDealForecastScores)
      .where(eq(crmDealForecastScores.organizationId, fixture.orgId));

    expect(scores).toHaveLength(3);
    for (const score of scores) {
      expect(Number(score.probability)).toBeGreaterThan(0);
      expect(Number(score.probability)).toBeLessThan(1);
      /** The interval is what makes a small-sample model honest. */
      expect(Number(score.intervalLower)).toBeLessThanOrEqual(Number(score.probability));
      expect(Number(score.intervalUpper)).toBeGreaterThanOrEqual(Number(score.probability));
      /** Without these a rep who disagrees with the number has nothing to argue with. */
      expect(Object.keys(score.features).length).toBeGreaterThan(0);
      expect(score.factors.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("reports a learned basis, carrying the evidence it was accepted on", async () => {
    const basis = await asTenant(() => trainer.describeBasis(fixture.orgId, NOW));

    expect(basis.kind).toBe("learned");
    if (basis.kind !== "learned") throw new Error("unreachable");
    expect(basis.featureSpecVersion).toBeTruthy();
    expect(basis.holdoutDeals).toBeGreaterThanOrEqual(10);
    /** Both arms, because the model's own Brier alone is unreadable. */
    expect(basis.holdout.count).toBe(basis.naiveHoldout.count);
  }, 120_000);

  it("weights the pipeline read by the stored scores", async () => {
    const probabilities = await asTenant(() =>
      trainer.probabilitiesForOpenDeals(fixture.orgId),
    );
    expect(probabilities.size).toBe(3);
    for (const probability of probabilities.values()) {
      expect(probability).toBeGreaterThan(0);
      expect(probability).toBeLessThan(1);
    }
  }, 120_000);

  it("supersedes the previous model and keeps the date the tenant first had one", async () => {
    const before = await activeModels();
    const firstAvailable = before[0]!.becameAvailableAt.getTime();

    const again = await asTenant(() => trainer.train(fixture.orgId, new Date(NOW.getTime() + DAY_MS)));
    expect(again.trained).toBe(true);

    const after = await activeModels();
    /** The partial unique index only holds if the old row is stood down first. */
    expect(after).toHaveLength(1);
    expect(after[0]!.modelId).not.toBe(before[0]!.modelId);
    /**
     * Crossing the threshold happened at a time. "Learned since Tuesday" must
     * not quietly come to mean "retrained on Tuesday".
     */
    expect(after[0]!.becameAvailableAt.getTime()).toBe(firstAvailable);
  }, 300_000);
});
