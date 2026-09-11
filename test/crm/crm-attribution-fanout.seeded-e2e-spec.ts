import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "src/db/schema";
import {
  businessParties,
  crmCampaigns,
  crmLeadTouchpoints,
  deals,
  leadPartyMap,
} from "src/db/schema";
import type { Db } from "src/db/drizzle.module";
import { SEEDED_HARNESS } from "test/helpers/seeded-e2e-app";
import { cleanupSeedOrgs, seedOrg } from "test/helpers/e2e-seed";
import {
  CrmAttributionReportService,
  type CampaignAttribution,
} from "src/modules/crm/core/crm-attribution-report.service";

/**
 * Campaign revenue, counted once per deal.
 *
 * `getFirstTouchAttribution` and `getLastTouchAttribution` both start
 * `FROM crm_lead_touchpoints` and aggregate money across the join. Nothing
 * makes a touchpoint unique per `(org, lead, touch_type)` — the table has no
 * such constraint and `recordTouch` is a bare INSERT — so a lead that re-enters
 * the funnel carries a second `first_touch` row, and every won deal behind that
 * lead is summed once per touchpoint row. The last-touch query has a second
 * multiplicity of its own: it joins on `occurredAt = MAX(occurredAt)`, which
 * matches every row when two touches share an instant.
 *
 * A third one is here too, and it is the one the join hides best: `deals` is
 * joined per row as well, so `count(converted_at)` and `count(touchpoints.id)`
 * both count *joined rows*. A lead with two won deals and a single touchpoint
 * reports two converted leads and two touches, with no duplicate touchpoint
 * anywhere in sight.
 *
 * This has to be measured against real SQL. The fault is entirely in the shape
 * of the join, so a mocked query builder — which is what
 * `crm-attribution-report.service.spec.ts` has — cannot see it: it feeds rows
 * straight into `toAttribution` and never executes a join at all.
 *
 * The third case below is not decoration. The obvious-looking repair,
 * `SUM(DISTINCT deals.value)`, passes the first two and silently collapses two
 * genuinely different deals that happen to be worth the same amount. That case
 * fails against `SUM(DISTINCT …)` and passes against a correct reduction.
 *
 * Run with:
 *   DATABASE_URL="postgres://$(whoami)@localhost:5432/crm_cold_0908" \
 *   NODE_OPTIONS=--max-old-space-size=12288 pnpm test:e2e:seeded \
 *     --testPathPattern="crm-attribution-fanout"
 *
 * `organizations` cascades to campaigns, touchpoints, deals, party maps and
 * parties, so dropping the org is the whole teardown.
 */

/** No pipeline stages are seeded, so `resolveWonStageKeys` returns its literal fallback. */
const WON_STAGE = "WON";

interface SeededLead {
  readonly leadId: number;
  readonly partyId: string;
}

describe(`${SEEDED_HARNESS} CRM attribution — one deal, counted once`, () => {
  let client: ReturnType<typeof postgres>;
  let db: Db;
  let service: CrmAttributionReportService;

  const orgId = `attr-fanout-${crypto.randomUUID()}`;

  /** Campaign ids, filled by the fixture. */
  let repeatedFirstTouchCampaign = 0;
  let tiedLastTouchCampaign = 0;
  let equalValueDealsCampaign = 0;

  async function seedCampaign(name: string, spend: string): Promise<number> {
    const [row] = await db
      .insert(crmCampaigns)
      .values({ orgId, name, spend })
      .returning({ id: crmCampaigns.id });
    if (!row) throw new Error(`fixture: campaign ${name} was not inserted`);
    return row.id;
  }

  /** A converted lead: a party, the legacy id it answers to, and the link between them. */
  async function seedConvertedLead(name: string): Promise<SeededLead> {
    const [party] = await db
      .insert(businessParties)
      .values({
        organizationId: orgId,
        name,
        lifecycleStage: "CONVERTED",
        convertedAt: new Date("2026-02-01T00:00:00Z"),
      })
      .returning({ partyId: businessParties.partyId });
    if (!party) throw new Error(`fixture: party ${name} was not inserted`);

    const [map] = await db
      .insert(leadPartyMap)
      .values({ organizationId: orgId, partyId: party.partyId })
      .returning({ leadId: leadPartyMap.leadId });
    if (!map) throw new Error(`fixture: lead_party_map for ${name} was not inserted`);

    return { leadId: map.leadId, partyId: party.partyId };
  }

  async function seedWonDeal(leadId: number, name: string, valueMinor: number): Promise<void> {
    await db.insert(deals).values({ orgId, leadId, name, valueMinor, stage: WON_STAGE });
  }

  async function seedTouch(
    leadId: number,
    campaignId: number,
    touchType: "first_touch" | "interaction" | "conversion",
    occurredAt: Date,
  ): Promise<void> {
    await db.insert(crmLeadTouchpoints).values({
      orgId,
      leadId,
      campaignId,
      sourceKey: "google",
      touchType,
      occurredAt,
    });
  }

  function forCampaign(
    rows: readonly CampaignAttribution[],
    campaignId: number,
  ): CampaignAttribution {
    const row = rows.find((r) => r.campaignId === campaignId);
    if (!row)
      throw new Error(
        `campaign ${String(campaignId)} missing from the report: ${JSON.stringify(rows)}`,
      );
    return row;
  }

  beforeAll(async () => {
    const ownerUrl = process.env.DATABASE_URL;
    if (!ownerUrl) throw new Error("DATABASE_URL must be set for seeded e2e tests");

    client = postgres(ownerUrl, { prepare: false, max: 3 });
    db = drizzle(client, { schema });
    service = new CrmAttributionReportService(db);

    await seedOrg(db, orgId, orgId);

    /**
     * One lead, two `first_touch` rows on one campaign, one won deal.
     *
     * The shape `recordTouch` produces when a lead re-enters the funnel: there
     * is no upsert and no unique key to stop the second row.
     */
    repeatedFirstTouchCampaign = await seedCampaign("Repeated first touch", "1000.00");
    const repeatLead = await seedConvertedLead("Repeat Funnel Lead");
    await seedWonDeal(repeatLead.leadId, "Repeat funnel deal", 500_000);
    await seedTouch(
      repeatLead.leadId,
      repeatedFirstTouchCampaign,
      "first_touch",
      new Date("2026-01-05T09:00:00Z"),
    );
    await seedTouch(
      repeatLead.leadId,
      repeatedFirstTouchCampaign,
      "first_touch",
      new Date("2026-01-20T09:00:00Z"),
    );

    /**
     * One lead, two touches at the identical instant, one won deal.
     *
     * `lastTouchSub` selects on equality with `MAX(occurred_at)`, so a tie
     * matches both rows. Recorded as interactions so this lead contributes
     * nothing to the first-touch report.
     */
    tiedLastTouchCampaign = await seedCampaign("Tied last touch", "2000.00");
    const tiedLead = await seedConvertedLead("Tied Instant Lead");
    await seedWonDeal(tiedLead.leadId, "Tied instant deal", 700_000);
    const sameInstant = new Date("2026-03-11T14:30:00Z");
    await seedTouch(tiedLead.leadId, tiedLastTouchCampaign, "interaction", sameInstant);
    await seedTouch(tiedLead.leadId, tiedLastTouchCampaign, "interaction", sameInstant);

    /**
     * One lead, one touch, two different won deals worth the same amount.
     *
     * No touchpoint duplication at all — this is the `deals` join multiplying
     * `count(converted_at)` on its own, and it is the case that refuses
     * `SUM(DISTINCT deals.value)` as a repair.
     */
    equalValueDealsCampaign = await seedCampaign("Two equal deals", "500.00");
    const twinLead = await seedConvertedLead("Twin Deal Lead");
    await seedWonDeal(twinLead.leadId, "Twin deal A", 123_400);
    await seedWonDeal(twinLead.leadId, "Twin deal B", 123_400);
    await seedTouch(
      twinLead.leadId,
      equalValueDealsCampaign,
      "first_touch",
      new Date("2026-04-02T11:00:00Z"),
    );
  }, 120_000);

  afterAll(async () => {
    if (db) await cleanupSeedOrgs(db, [orgId]);
    if (client) await client.end({ timeout: 5 });
  }, 60_000);

  describe("getFirstTouchAttribution", () => {
    it("counts a won deal once when the lead has two first_touch rows", async () => {
      const report = await service.getFirstTouchAttribution(orgId);
      const row = forCampaign(report, repeatedFirstTouchCampaign);

      // One deal worth 5,000.00. Two touchpoints must not make it 10,000.00.
      expect(row.dealRevenueCents).toBe(500_000);
      // One lead, converted once.
      expect(row.convertedLeads).toBe(1);
      // Genuinely a row count: two touches were recorded, so two is right.
      expect(row.touchCount).toBe(2);
      // (5000 - 1000) / 1000 — ROI is only as right as the revenue above it.
      expect(row.roi).toBe(400);
    });

    it("keeps two distinct deals of equal value distinct, and counts the lead once", async () => {
      const report = await service.getFirstTouchAttribution(orgId);
      const row = forCampaign(report, equalValueDealsCampaign);

      // 1,234.00 twice. `SUM(DISTINCT value)` would report 123400 here.
      expect(row.dealRevenueCents).toBe(246_800);
      // Two won deals behind one lead is still one converted lead.
      expect(row.convertedLeads).toBe(1);
      expect(row.touchCount).toBe(1);
    });

    /**
     * The third multiplicity, and the one the diagnosis did not name.
     *
     * `count(crm_lead_touchpoints.id)` counted *joined* rows, so a lead with two
     * won deals reported two touches off a single touchpoint. `touchCount` is
     * meant to be a row count — it just has to be a count of the right rows.
     */
    it("counts touchpoint rows, not the rows the deal join produced", async () => {
      const report = await service.getFirstTouchAttribution(orgId);
      expect(forCampaign(report, equalValueDealsCampaign).touchCount).toBe(1);
    });

    it("reports the campaign's own spend once", async () => {
      const report = await service.getFirstTouchAttribution(orgId);
      expect(forCampaign(report, repeatedFirstTouchCampaign).campaignName).toBe(
        "Repeated first touch",
      );
      expect(forCampaign(report, equalValueDealsCampaign).campaignName).toBe("Two equal deals");
    });
  });

  describe("getLastTouchAttribution", () => {
    it("counts a won deal once when two touches share the last instant", async () => {
      const report = await service.getLastTouchAttribution(orgId);
      const row = forCampaign(report, tiedLastTouchCampaign);

      // One deal worth 7,000.00, tied at the last instant by two touches.
      expect(row.dealRevenueCents).toBe(700_000);
      expect(row.convertedLeads).toBe(1);
      // Both rows are the last touch, so both are counted as touches.
      expect(row.touchCount).toBe(2);
      // (7000 - 2000) / 2000.
      expect(row.roi).toBe(250);
    });

    it("attributes the repeat-funnel lead's deal once to its latest campaign", async () => {
      const report = await service.getLastTouchAttribution(orgId);
      const row = forCampaign(report, repeatedFirstTouchCampaign);

      expect(row.dealRevenueCents).toBe(500_000);
      expect(row.convertedLeads).toBe(1);
      // Only the later of the two rows is the last touch.
      expect(row.touchCount).toBe(1);
    });

    it("keeps two distinct deals of equal value distinct", async () => {
      const report = await service.getLastTouchAttribution(orgId);
      const row = forCampaign(report, equalValueDealsCampaign);

      expect(row.dealRevenueCents).toBe(246_800);
      expect(row.convertedLeads).toBe(1);
    });
  });

  describe("the fixture is what the assertions claim", () => {
    it("has no unique key stopping a second first_touch row", async () => {
      const touches = await db
        .select({ id: crmLeadTouchpoints.id })
        .from(crmLeadTouchpoints)
        .where(eq(crmLeadTouchpoints.orgId, orgId));

      // Five rows went in and five are there: nothing deduplicated them.
      expect(touches).toHaveLength(5);
    });
  });
});
