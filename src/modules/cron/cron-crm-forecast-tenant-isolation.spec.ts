jest.mock("../../common/tenant", () => ({
  ...jest.requireActual("../../common/tenant"),
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../common/tenant";
import { crmDealForecastModels } from "../../db/schema";
import { tenantDb } from "../../test/tenant-recorder";
import { CronCrmForecastService } from "./cron-crm-forecast.service";

/**
 * Cross-tenant isolation for the nightly forecast sweep.
 *
 * The sweep decides per org whether its model is stale, from that org's own
 * active model. The OWNER has a fresh one; the attacker has none. If the model
 * read lost its org predicate, the owner's fresh model would make the
 * attacker's look fresh too, and the attacker's forecast would never be
 * trained — and the sweep would score the attacker's pipeline as if the owner's
 * model were its own.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const NOW = new Date("2026-09-11T02:00:00Z");

function build() {
  const t = tenantDb({
    fixtures: [
      {
        table: crmDealForecastModels,
        org: crmDealForecastModels.organizationId,
        rows: [{ organizationId: OWNER_ORG, status: "active", trainedAt: new Date("2026-09-10T02:00:00Z") }],
      },
    ],
  });
  const forecast = {
    train: jest.fn(async () => ({ trained: false })),
    scoreOpenDeals: jest.fn(async () => 0),
  };
  (forEachOrg as jest.Mock).mockReset();
  const sweepOver = (orgIds: string[]) =>
    (forEachOrg as jest.Mock).mockImplementation(
      async (_db: unknown, _sweep: string, fn: (tx: unknown, orgId: string) => Promise<void>) => {
        for (const orgId of orgIds) await fn(t.db, orgId);
        return { succeeded: orgIds.length, failed: 0 };
      },
    );
  return { t, forecast, sweepOver, service: new CronCrmForecastService(t.db, forecast as never) };
}

describe("CronCrmForecastService — cross-tenant isolation", () => {
  it("deny: another org's fresh model does not make the caller's missing model look fresh", async () => {
    const s = build();
    s.sweepOver([ATTACKER_ORG]);

    const result = await s.service.sweep(NOW);

    expect(s.forecast.train).toHaveBeenCalledWith(ATTACKER_ORG, NOW);
    expect(result).toMatchObject({ trained: 0, refused: 1 });
    expect(s.t.orgBound(s.t.on(crmDealForecastModels, "select")[0], crmDealForecastModels.organizationId)).toEqual([
      ATTACKER_ORG,
    ]);
  });

  it("deny: in a mixed sweep each org is trained and scored as itself only", async () => {
    const s = build();
    s.sweepOver([ATTACKER_ORG, OWNER_ORG]);

    await s.service.sweep(NOW);

    expect(s.forecast.train.mock.calls).toEqual([[ATTACKER_ORG, NOW]]);
    expect(s.forecast.scoreOpenDeals.mock.calls).toEqual([
      [ATTACKER_ORG, NOW],
      [OWNER_ORG, NOW],
    ]);
  });

  it("control: the owning org's fresh model is scored, not retrained", async () => {
    const s = build();
    s.sweepOver([OWNER_ORG]);

    const result = await s.service.sweep(NOW);

    expect(s.forecast.train).not.toHaveBeenCalled();
    expect(s.forecast.scoreOpenDeals).toHaveBeenCalledWith(OWNER_ORG, NOW);
    expect(result).toMatchObject({ organizations: 1, trained: 0, refused: 0 });
  });
});
