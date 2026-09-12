import { NotFoundException } from "@nestjs/common";
import { crmDealCompetitorSuggestions, crmDealCompetitors, crmOptions, deals } from "../../db/schema";
import { tenantDb } from "../../test/tenant-recorder";
import { DealsCompetitorSuggestionsService } from "./deals-competitor-suggestions.service";

/**
 * Cross-tenant isolation for competitor suggestions on a deal.
 *
 * Two ways across the boundary, both covered: naming the OWNER's deal or
 * suggestion id directly, and — subtler — the scan borrowing another org's
 * competitor vocabulary. The OWNER tracks "Acme"; the attacker's own deal
 * timeline mentions Acme. If either vocabulary read lost its org predicate, the
 * owner's rival list would turn into a suggestion on the attacker's deal.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const actorIn = (orgId: string) => ({ orgId, userId: `usr-${orgId}` }) as never;

function build() {
  const t = tenantDb({
    fixtures: [
      {
        table: deals,
        org: deals.orgId,
        rows: [
          { orgId: OWNER_ORG, id: 42, deletedAt: null },
          { orgId: ATTACKER_ORG, id: 43, deletedAt: null },
        ],
      },
      {
        table: crmDealCompetitorSuggestions,
        org: crmDealCompetitorSuggestions.organizationId,
        rows: [
          {
            organizationId: OWNER_ORG,
            dealId: 42,
            competitorSuggestionId: "sug-owner",
            competitorKey: "acme",
            status: "pending",
            sourceKind: "activity",
            sourceActivityId: "act-owner",
            evidenceQuote: "evaluating Acme",
            decidedByUserId: null,
            decidedByName: null,
            decidedAt: null,
            decisionNote: null,
            appliedCompetitorId: null,
            createdAt: new Date("2026-09-01"),
          },
        ],
      },
      {
        table: crmDealCompetitors,
        org: crmDealCompetitors.orgId,
        rows: [{ orgId: OWNER_ORG, dealId: 42, id: "comp-owner", competitorKey: "acme" }],
      },
      {
        table: crmOptions,
        org: crmOptions.orgId,
        rows: [{ orgId: OWNER_ORG, type: "competitor", isActive: true, key: "acme", label: "Acme" }],
      },
    ],
  });
  const activities = {
    timeline: jest.fn(async () => ({
      data: [{ activityId: "act-attacker", subject: "Pricing call", body: "They are also talking to Acme about pricing." }],
    })),
  };
  return { t, activities, service: new DealsCompetitorSuggestionsService(t.db, activities as never) };
}

describe("DealsCompetitorSuggestionsService — cross-tenant isolation", () => {
  it("deny: another org's deal is a 404 before any suggestion is read or scanned", async () => {
    const { t, activities, service } = build();

    await expect(service.list(ATTACKER_ORG, 42, {} as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.scan(ATTACKER_ORG, 42)).rejects.toBeInstanceOf(NotFoundException);
    for (const check of t.on(deals, "select")) expect(t.orgBound(check, deals.orgId)).toEqual([ATTACKER_ORG]);
    expect(activities.timeline).not.toHaveBeenCalled();
    expect(t.on(crmDealCompetitorSuggestions)).toHaveLength(0);
  });

  it("deny: another org's suggestion id cannot be accepted or dismissed from the caller's own deal", async () => {
    const { t, service } = build();

    await expect(
      service.accept(actorIn(ATTACKER_ORG), 43, "sug-owner", { confirmedCompetitorKey: "acme" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.dismiss(actorIn(ATTACKER_ORG), 43, "sug-owner", {} as never)).rejects.toBeInstanceOf(NotFoundException);
    for (const read of t.on(crmDealCompetitorSuggestions, "select"))
      expect(t.orgBound(read, crmDealCompetitorSuggestions.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.on(crmDealCompetitors, "insert")).toHaveLength(0);
    expect(t.on(crmDealCompetitorSuggestions, "update")).toHaveLength(0);
  });

  it("deny: a scan of the caller's own deal never borrows another org's competitor list", async () => {
    const { t, service } = build();

    const result = await service.scan(ATTACKER_ORG, 43);

    expect(result).toMatchObject({ proposed: 0, vocabularySize: 0, activitiesScanned: 1 });
    expect(t.on(crmDealCompetitorSuggestions, "insert")).toHaveLength(0);
    expect(t.orgBound(t.on(crmOptions, "select")[0], crmOptions.orgId)).toEqual([ATTACKER_ORG]);
    for (const read of t.on(crmDealCompetitors, "select")) expect(t.orgBound(read, crmDealCompetitors.orgId)).toEqual([ATTACKER_ORG]);
  });

  it("control: the owning org lists its deal's pending suggestion and scans with its own vocabulary", async () => {
    const { service } = build();

    expect((await service.list(OWNER_ORG, 42, {} as never)).map((s) => s.competitorSuggestionId)).toEqual(["sug-owner"]);
    expect(await service.scan(OWNER_ORG, 42)).toMatchObject({ vocabularySize: 1, alreadyTracked: 1, proposed: 0 });
  });
});
