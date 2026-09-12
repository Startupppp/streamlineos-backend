import { activities, crmCampaigns, crmLeadTouchpoints, crmPipelineStages, deals } from "../../db/schema";
import { tenantDb } from "../../test/tenant-recorder";
import { AttributionReportService } from "./attribution-report.service";

/**
 * Cross-tenant isolation for the marketing attribution report.
 *
 * The report reads five things — won-stage keys, won deals, lead touchpoints,
 * deal activities and campaign names — and every one must stay in the caller's
 * org. The sharpest case is the last: the attacker's own touchpoint cites
 * campaign id 3, which is the OWNER's campaign. The report must not borrow the
 * owner's campaign name for it. The double answers each statement by the
 * equalities it bound, so a missing org predicate on any read hands the owner's
 * row to the attacker.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const OWNER_CAMPAIGN_NAME = "Owner Q2 search";

function build() {
  const t = tenantDb({
    fixtures: [
      {
        table: crmPipelineStages,
        org: crmPipelineStages.orgId,
        rows: [
          { orgId: OWNER_ORG, stageType: "won", key: "WON" },
          { orgId: ATTACKER_ORG, stageType: "won", key: "WON" },
        ],
      },
      {
        table: deals,
        org: deals.orgId,
        rows: [
          { orgId: OWNER_ORG, id: 42, leadId: 7, valueMinor: 100_000, actualCloseDate: "2026-06-30", updatedAt: new Date("2026-06-30"), deletedAt: null },
          { orgId: ATTACKER_ORG, id: 43, leadId: 9, valueMinor: 50_000, actualCloseDate: "2026-06-30", updatedAt: new Date("2026-06-30"), deletedAt: null },
        ],
      },
      {
        table: crmLeadTouchpoints,
        org: crmLeadTouchpoints.orgId,
        rows: [
          { orgId: OWNER_ORG, id: 1, leadId: 7, campaignId: 3, sourceKey: "google_ads", touchType: "click", occurredAt: new Date("2026-05-01") },
          { orgId: ATTACKER_ORG, id: 2, leadId: 9, campaignId: 3, sourceKey: "google_ads", touchType: "click", occurredAt: new Date("2026-05-02") },
        ],
      },
      {
        table: activities,
        org: activities.organizationId,
        rows: [
          { organizationId: OWNER_ORG, activityId: "act-owner", dealId: 42, kind: "call", subject: "Discovery", occurredAt: new Date("2026-06-01"), deletedAt: null },
        ],
      },
      {
        table: crmCampaigns,
        org: crmCampaigns.orgId,
        rows: [{ orgId: OWNER_ORG, id: 3, name: OWNER_CAMPAIGN_NAME, deletedAt: null }],
      },
    ],
  });
  return { t, service: new AttributionReportService(t.db) };
}

describe("AttributionReportService — cross-tenant isolation", () => {
  it("deny: the attacker's report counts none of another org's won deals or revenue", async () => {
    const { t, service } = build();

    const report = await service.getReport(ATTACKER_ORG, "linear", 30);

    expect(report.dealsConsidered).toBe(1);
    expect(report.totalRevenueMinor).toBe(50_000);
    expect(t.orgBound(t.on(crmPipelineStages, "select")[0], crmPipelineStages.orgId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(deals, "select")[0], deals.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: a campaign id that collides with another org's campaign never borrows that campaign's name", async () => {
    const { t, service } = build();

    const report = await service.getReport(ATTACKER_ORG, "linear", 30);

    expect(report.campaigns.map((campaign) => campaign.campaignId)).toEqual([3]);
    expect(JSON.stringify(report)).not.toContain(OWNER_CAMPAIGN_NAME);
    expect(t.orgBound(t.on(crmCampaigns, "select")[0], crmCampaigns.orgId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(crmLeadTouchpoints, "select")[0], crmLeadTouchpoints.orgId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(t.on(activities, "select")[0], activities.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org's report attributes its own deal to its own named campaign", async () => {
    const { service } = build();

    const report = await service.getReport(OWNER_ORG, "linear", 30);

    expect(report.dealsConsidered).toBe(1);
    expect(report.totalRevenueMinor).toBe(100_000);
    expect(report.campaigns.find((campaign) => campaign.campaignId === 3)?.campaignName).toBe(OWNER_CAMPAIGN_NAME);
  });
});
