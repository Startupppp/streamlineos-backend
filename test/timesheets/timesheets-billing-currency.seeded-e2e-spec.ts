import request from "supertest";
import { orgModules, timesheets as timesheetEntries } from "src/db/schema";
import {
  SEEDED_HARNESS,
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * TS-18. A project billed in two currencies must never be summed into one
 * number.
 *
 * The organisation-level total already refused to do this — `amount: mixed ?
 * null` with a comment saying callers must never see a cross-currency sum. The
 * per-project rows underneath it did exactly that: `GROUP BY project_id` with
 * `SUM(hours * bill_rate)` and `MAX(currency)`, so a project billed in USD and
 * INR produced one added-up figure stamped with whichever code sorted highest.
 * The care was there; it stopped one level too high.
 *
 * The rows are now grouped by (project, currency), so such a project appears
 * once per currency with its own money and its own label. That is the shape the
 * table already renders — it prints a currency per row.
 *
 * The assertions deliberately name the amounts rather than only counting rows:
 * two rows with the wrong split would satisfy a count.
 *
 * Run with:
 *   DATABASE_URL=postgres://owner@host/db \
 *   APP_DATABASE_URL=postgres://streamline_app@host/db \
 *   node --max-old-space-size=12288 ./node_modules/jest/bin/jest.js \
 *     --config ./jest-e2e-seeded.json --forceExit --runInBand \
 *     --testPathPattern=timesheets-billing-currency
 */

interface BillingGroup {
  projectId: number;
  totalHours: number;
  billableAmount: number;
  currency: string;
}

describe(`${SEEDED_HARNESS} timesheet billing never sums two currencies`, () => {
  let seeded: SeededE2eApp;
  let fixture: SeededFixture;
  let token = "";
  let projectId = 0;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    fixture = await seedOrg(seeded.seedDb)
      .addMember("biller", {
        permissionKeys: ["timesheets:billing:view", "timesheets:entries:view"],
      })
      .addProject("alpha")
      .build();

    await seeded.seedDb
      .insert(orgModules)
      .values([
        { orgId: fixture.orgId, moduleKey: "timesheets", enabled: true },
        { orgId: fixture.orgId, moduleKey: "build", enabled: true },
      ])
      .onConflictDoNothing();

    const biller = fixture.members["biller"];
    const project = fixture.projects["alpha"];
    if (!biller || !project) throw new Error("fixture members/projects missing");
    token = await signSeededToken(seeded, biller.userId, fixture.orgId);
    projectId = project.projectId;

    /**
     * Written directly rather than through the API: `currency` is filled from
     * the resolved rate at creation, and the point here is a project that has
     * ended up with two of them. Different dates because one ticket-less entry
     * per person per day is enforced by a unique index.
     */
    await seeded.seedDb.insert(timesheetEntries).values([
      {
        orgId: fixture.orgId,
        userMembershipId: biller.membershipId,
        projectId,
        date: "2026-04-06",
        hours: "10.00",
        description: "billed in USD",
        status: "APPROVED" as const,
        isBillable: true,
        billRate: "100.00",
        currency: "USD",
        invoicingStatus: "UNINVOICED" as const,
      },
      {
        orgId: fixture.orgId,
        userMembershipId: biller.membershipId,
        projectId,
        date: "2026-04-07",
        hours: "5.00",
        description: "billed in INR",
        status: "APPROVED" as const,
        isBillable: true,
        billRate: "8000.00",
        currency: "INR",
        invoicingStatus: "UNINVOICED" as const,
      },
    ]);
  }, 240_000);

  afterAll(async () => {
    await fixture?.teardown();
    await seeded?.close();
  }, 60_000);

  const summary = () =>
    request(seeded.app.getHttpServer())
      .get("/timesheets/billing/uninvoiced?startDate=2026-04-01&endDate=2026-04-30")
      .set("Authorization", `Bearer ${token}`);

  it("splits one project into a row per currency", async () => {
    const res = await summary();
    expect(res.status).toBe(200);

    const groups = (res.body.groups as BillingGroup[]).filter((g) => g.projectId === projectId);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.currency).sort()).toEqual(["INR", "USD"]);
  }, 60_000);

  it("keeps each currency's money with its own currency", async () => {
    const res = await summary();
    const groups = (res.body.groups as BillingGroup[]).filter((g) => g.projectId === projectId);
    const usd = groups.find((g) => g.currency === "USD");
    const inr = groups.find((g) => g.currency === "INR");

    /** 10h × 100 and 5h × 8000 — never 41,000 of anything. */
    expect(usd).toMatchObject({ totalHours: 10, billableAmount: 1000 });
    expect(inr).toMatchObject({ totalHours: 5, billableAmount: 40000 });
    expect(groups.some((g) => g.billableAmount === 41000)).toBe(false);
  }, 60_000);

  it("reports the organisation total as mixed, with no single amount", async () => {
    const res = await summary();
    const totals = res.body.totals;

    expect(totals.mixed).toBe(true);
    expect(totals.amount).toBeNull();
    expect(totals.currency).toBeNull();
    expect(totals.hours).toBe(15);

    const byCurrency = totals.byCurrency as Array<{ currency: string; amount: number }>;
    expect(byCurrency.find((c) => c.currency === "USD")?.amount).toBe(1000);
    expect(byCurrency.find((c) => c.currency === "INR")?.amount).toBe(40000);
  }, 60_000);

  /**
   * Conversion is evidence, not a replacement: the per-currency figures above
   * stay, and the converted view is offered alongside them.
   */
  it("offers conversion evidence against the org default currency", async () => {
    const res = await summary();
    expect(res.body.totals.converted).not.toBeUndefined();
  }, 60_000);
});
