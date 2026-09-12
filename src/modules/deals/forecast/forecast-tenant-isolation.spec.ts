import { crmDealForecastModels, crmDealForecastScores, deals } from "../../../db/schema";
import { tenantDb, type TenantFixture } from "../../../test/tenant-recorder";
import { DEAL_FEATURE_NAMES, FORECAST_FEATURE_SPEC_VERSION } from "./deal-forecast-features";
import { ForecastCorpusService } from "./forecast-corpus.service";
import { featureValuesFrom, featureValuesToRecord } from "./forecast-model-store";
import { ForecastTrainingService } from "./forecast-training.service";
import { fitLogisticModel, type TrainingExample } from "./logistic-regression";

/**
 * Cross-tenant isolation for the learned deal forecast: the corpus it is
 * trained on and the model and scores it serves.
 *
 * A forecast trained on another tenant's closed deals would leak that tenant's
 * win rates into every probability it produced, and a score served from another
 * tenant's model would be a number produced by somebody else's pipeline. The
 * fixtures hold the OWNER's closed and open deals, its active model (a real fit,
 * so it rehydrates) and a stored score; the double answers each statement by
 * the equalities it bound, so a missing org predicate hands them to the
 * attacker.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const NOW = new Date("2026-09-11T00:00:00Z");

const STAGES = {
  wonKeys: ["WON"],
  lostKeys: ["LOST"],
  stageProbabilities: new Map<string, number>([["PROPOSAL", 60]]),
};

function corpus(): TrainingExample[] {
  return Array.from({ length: 40 }, (_, index) => {
    const won = index % 2 === 0;
    return {
      dealId: index + 1,
      closedAt: new Date(2026, 0, index + 1),
      outcome: won ? "won" : "lost",
      values: featureValuesFrom((name) =>
        name === "activityCount" ? (won ? 12 : 2) : (DEAL_FEATURE_NAMES.indexOf(name) % 3) + index / 40,
      ),
    } as TrainingExample;
  });
}

const fitted = fitLogisticModel(corpus());
const modelRow = (orgId: string, modelId: string) => ({
  organizationId: orgId,
  status: "active",
  crmDealForecastModelId: modelId,
  featureSpecVersion: FORECAST_FEATURE_SPEC_VERSION,
  coefficients: {
    intercept: fitted.intercept,
    weights: featureValuesToRecord(fitted.weights),
    means: featureValuesToRecord(fitted.means),
    deviations: featureValuesToRecord(fitted.deviations),
    covariance: fitted.covariance.map((row) => [...row]),
  },
  ridge: fitted.ridge,
  iterations: fitted.iterations,
  converged: fitted.converged,
  trainingDeals: fitted.exampleCount,
  wonDeals: fitted.wonCount,
  holdoutDeals: 10,
  trainedAt: new Date("2026-09-10T00:00:00Z"),
  becameAvailableAt: new Date("2026-09-10T00:00:00Z"),
  evaluation: null,
});
const OWNER_SCORE = {
  organizationId: OWNER_ORG,
  dealId: 77,
  crmDealForecastModelId: "model-owner",
  probability: "0.62",
  intervalLower: "0.5",
  intervalUpper: "0.7",
  expectedValueMinor: "3100",
  asOf: new Date("2026-09-10T00:00:00Z"),
  scoredAt: new Date("2026-09-10T00:00:00Z"),
  factors: [],
};

describe("ForecastCorpusService — cross-tenant isolation", () => {
  function build(dealRows: Array<Record<string, unknown>>) {
    const t = tenantDb({ fixtures: [{ table: deals, org: deals.orgId, rows: dealRows }] });
    const crmMetadata = {
      getAggregate: jest.fn(async () => ({
        stages: [
          { key: "WON", stageType: "won", isActive: true, probability: 100 },
          { key: "LOST", stageType: "lost", isActive: true, probability: 0 },
        ],
      })),
    };
    return { t, crmMetadata, service: new ForecastCorpusService(t.db, crmMetadata as never) };
  }
  const CLOSED = [
    { orgId: OWNER_ORG, deletedAt: null, stage: "WON", closed: 12 },
    { orgId: OWNER_ORG, deletedAt: null, stage: "LOST", closed: 30 },
  ];
  const OPEN = [
    {
      orgId: OWNER_ORG,
      deletedAt: null,
      dealId: 77,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      stage: "PROPOSAL",
      valueMinor: 5000,
      expectedCloseDate: null,
      assignedToId: "usr-owner-rep",
      sourceKey: null,
    },
  ];

  it("deny: another org's closed deals never count toward the caller's forecast readiness", async () => {
    const { t, crmMetadata, service } = build(CLOSED);

    expect(await service.closedOutcomeCounts(ATTACKER_ORG, NOW)).toEqual({ won: 0, lost: 0 });
    expect(crmMetadata.getAggregate).toHaveBeenCalledWith(ATTACKER_ORG);
    expect(t.orgBound(t.on(deals, "select")[0], deals.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: another org's open pipeline is never loaded for scoring", async () => {
    const { t, service } = build(OPEN);

    expect(await service.loadOpenDeals(ATTACKER_ORG, STAGES)).toEqual([]);
    expect(t.orgBound(t.on(deals, "select")[0], deals.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org counts its own closed deals and loads its own open deal", async () => {
    expect(await build(CLOSED).service.closedOutcomeCounts(OWNER_ORG, NOW)).toEqual({ won: 12, lost: 30 });
    const open = await build(OPEN).service.loadOpenDeals(OWNER_ORG, STAGES);
    expect(open.map((row) => row.snapshot.dealId)).toEqual([77]);
  });
});

describe("ForecastTrainingService — cross-tenant isolation", () => {
  function build(models: Array<Record<string, unknown>>) {
    const fixtures: TenantFixture[] = [
      { table: crmDealForecastModels, org: crmDealForecastModels.organizationId, rows: models },
      { table: crmDealForecastScores, org: crmDealForecastScores.organizationId, rows: [OWNER_SCORE] },
    ];
    const t = tenantDb({ fixtures });
    const service = new ForecastTrainingService(t.db, {} as never, { del: jest.fn() } as never);
    return { t, service };
  }

  it("deny: another org's active model never serves the caller a score", async () => {
    const { t, service } = build([modelRow(OWNER_ORG, "model-owner")]);

    expect(await service.scoreForDeal(ATTACKER_ORG, 77)).toBeNull();
    expect((await service.probabilitiesForOpenDeals(ATTACKER_ORG)).size).toBe(0);
    for (const read of t.on(crmDealForecastModels, "select"))
      expect(t.orgBound(read, crmDealForecastModels.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.on(crmDealForecastScores)).toHaveLength(0);
  });

  it("deny: with its own model, the caller's score read is still bound to its own org", async () => {
    const { t, service } = build([modelRow(OWNER_ORG, "model-owner"), modelRow(ATTACKER_ORG, "model-attacker")]);

    expect(await service.scoreForDeal(ATTACKER_ORG, 77)).toBeNull();
    expect(t.orgBound(t.on(crmDealForecastScores, "select")[0], crmDealForecastScores.organizationId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("control: the owning org's model serves its own deal's stored score", async () => {
    const { t, service } = build([modelRow(OWNER_ORG, "model-owner")]);

    expect(await service.scoreForDeal(OWNER_ORG, 77)).toMatchObject({ dealId: 77, probability: 0.62 });
    expect((await service.probabilitiesForOpenDeals(OWNER_ORG)).get(77)).toBeCloseTo(0.62);
    expect(t.orgBound(t.on(crmDealForecastScores, "select")[0], crmDealForecastScores.organizationId)).toEqual([OWNER_ORG]);
  });
});
