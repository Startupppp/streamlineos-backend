import { NotFoundException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { feedbackPosts } from "../../../db/schema";
import type { SelectedFields } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { ProjectsRoadmapService } from "./projects-roadmap.service";
import {
  ROADMAP_TIER_RANKS,
  ROADMAP_TIER_WEIGHTS,
  applyRoadmapTierWeighting,
  assertCrmOrganizationInOrg,
  loadRoadmapAccountTiers,
  type RoadmapAccountTierSummary,
} from "./roadmap-accounts";
import { computeRoadmapPrioritization } from "./roadmap-prioritization";

const realDb = drizzle(postgres("postgres://unused:unused@127.0.0.1:1/unused", { max: 1 }), {
  schema,
});

const ORG = "org-accounts";
const OTHER_ORG = "org-intruder";

/** reach 100 × impact 2 × 50% ÷ effort 1 = 100. */
const SCORED = computeRoadmapPrioritization({ reach: 100, impact: 2, confidence: 50, effort: 1 });
const UNSCORED = computeRoadmapPrioritization({ reach: 100, impact: 2, confidence: 50 });

function summary(overrides: Partial<RoadmapAccountTierSummary> = {}): RoadmapAccountTierSummary {
  return { linkedFeedbackCount: 0, linkedAccountCount: 0, topTier: null, ...overrides };
}

function groupedSelect(rows: unknown[]) {
  const projections: SelectedFields[] = [];
  const groupBy = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ groupBy });
  const secondJoin = jest.fn().mockReturnValue({ where });
  const firstJoin = jest.fn().mockReturnValue({ leftJoin: secondJoin });
  const from = jest.fn().mockReturnValue({ leftJoin: firstJoin });
  const select = jest.fn((projection: SelectedFields) => {
    projections.push(projection);
    return { from };
  });
  return { select, projections, db: { select } as unknown as Db };
}

/** The list path's stub: every builder method chains, `groupBy` is the tier read. */
function serviceSelectChain(tierRows: unknown[]) {
  const node: Record<string, unknown> = {};
  for (const method of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"])
    node[method] = jest.fn(() => node);
  node.groupBy = jest.fn(() => Promise.resolve(tierRows));
  node.then = (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve);
  return jest.fn(() => node);
}

function makeRoadmapService(rows: unknown[], tierRows: unknown[]) {
  const select = serviceSelectChain(tierRows);
  const db = {
    query: {
      roadmapItems: {
        findMany: jest.fn().mockResolvedValue(rows),
        findFirst: jest.fn(),
      },
    },
    select,
    insert: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
  return { service: new ProjectsRoadmapService(db, {} as never, {} as never), select };
}

function listRow(id: number, scored: boolean) {
  return {
    id,
    sortOrder: id,
    votes: 0,
    projectId: null,
    epicTicketId: null,
    reach: scored ? 100 : null,
    impact: scored ? 2 : null,
    confidence: scored ? 50 : null,
    effort: scored ? 1 : null,
  };
}

function lookupSelect(rows: unknown[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const select = jest.fn().mockReturnValue({ from });
  return { select, where, db: { select } as unknown as Db };
}

describe("applyRoadmapTierWeighting — a weighted score is never presented as authoritative without its inputs", () => {
  it("falls back to the plain RICE score and names no_linked_feedback when nothing links to the item", () => {
    const weighting = applyRoadmapTierWeighting(SCORED, summary());
    expect(weighting.tierWeighted).toBe(false);
    expect(weighting.unweightedReason).toBe("no_linked_feedback");
    expect(weighting.weightedScore).toBeNull();
    expect(weighting.tier).toBeNull();
  });

  it("falls back and names no_linked_account when the linked feedback names no company", () => {
    const weighting = applyRoadmapTierWeighting(SCORED, summary({ linkedFeedbackCount: 3 }));
    expect(weighting.tierWeighted).toBe(false);
    expect(weighting.unweightedReason).toBe("no_linked_account");
    expect(weighting.weightedScore).toBeNull();
  });

  it("falls back and names account_tier_unset when the linked accounts carry no tier", () => {
    const weighting = applyRoadmapTierWeighting(
      SCORED,
      summary({ linkedFeedbackCount: 3, linkedAccountCount: 2 }),
    );
    expect(weighting.tierWeighted).toBe(false);
    expect(weighting.unweightedReason).toBe("account_tier_unset");
    expect(weighting.weightedScore).toBeNull();
  });

  it("weights the score by the tier once the inputs are all present, proving the fallbacks are not universal", () => {
    const weighting = applyRoadmapTierWeighting(
      SCORED,
      summary({ linkedFeedbackCount: 1, linkedAccountCount: 1, topTier: "enterprise" }),
    );
    expect(weighting.tierWeighted).toBe(true);
    expect(weighting.unweightedReason).toBeNull();
    expect(weighting.tier).toBe("enterprise");
    expect(weighting.weight).toBe(ROADMAP_TIER_WEIGHTS.enterprise);
    expect(weighting.weightedScore).toBe(100 * ROADMAP_TIER_WEIGHTS.enterprise);
  });

  it("refuses to weight an unavailable RICE score and names score_unavailable rather than inventing one", () => {
    const weighting = applyRoadmapTierWeighting(
      UNSCORED,
      summary({ linkedFeedbackCount: 1, linkedAccountCount: 1, topTier: "pro" }),
    );
    expect(weighting.tierWeighted).toBe(false);
    expect(weighting.unweightedReason).toBe("score_unavailable");
    expect(weighting.weightedScore).toBeNull();
  });

  it("orders the weights so a higher tier can never score below a lower one", () => {
    expect(ROADMAP_TIER_WEIGHTS.enterprise).toBeGreaterThan(ROADMAP_TIER_WEIGHTS.pro);
    expect(ROADMAP_TIER_WEIGHTS.pro).toBeGreaterThan(ROADMAP_TIER_WEIGHTS.free);
  });
});

describe("loadRoadmapAccountTiers — one grouped query for a page, never one per item (BE-47)", () => {
  it("issues exactly one select for a page of five items", async () => {
    const { select, db } = groupedSelect([
      { itemId: 1, linkedFeedbackCount: 2, linkedAccountCount: 2, topTierRank: 3 },
      { itemId: 2, linkedFeedbackCount: 1, linkedAccountCount: 0, topTierRank: null },
    ]);
    await loadRoadmapAccountTiers(db, ORG, [1, 2, 3, 4, 5]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("costs no query at all when the page is empty", async () => {
    const { select, db } = groupedSelect([]);
    await expect(loadRoadmapAccountTiers(db, ORG, [])).resolves.toEqual(new Map());
    expect(select).not.toHaveBeenCalled();
  });

  it("resolves the highest tier rank the group returned back to its tier", async () => {
    const { db } = groupedSelect([
      { itemId: 1, linkedFeedbackCount: 3, linkedAccountCount: 3, topTierRank: 3 },
      { itemId: 2, linkedFeedbackCount: 1, linkedAccountCount: 1, topTierRank: 1 },
    ]);
    const tiers = await loadRoadmapAccountTiers(db, ORG, [1, 2]);
    expect(tiers.get(1)?.topTier).toBe("enterprise");
    expect(tiers.get(2)?.topTier).toBe("free");
  });

  it("returns no entry for an item the grouped query never mentioned, so the caller falls back rather than guesses", async () => {
    const { db } = groupedSelect([
      { itemId: 1, linkedFeedbackCount: 1, linkedAccountCount: 1, topTierRank: 2 },
    ]);
    const tiers = await loadRoadmapAccountTiers(db, ORG, [1, 9]);
    expect(tiers.has(9)).toBe(false);
    expect(tiers.get(1)?.topTier).toBe("pro");
  });
});

describe("the grouped query asks Postgres for the highest tier, not the first one it meets", () => {
  it("projects MAX over the tier ranks, so a page sharing a free and an enterprise account weights by enterprise", async () => {
    const { db, projections } = groupedSelect([]);
    await loadRoadmapAccountTiers(db, ORG, [1, 2]);

    const rendered = realDb.select(projections[0]).from(feedbackPosts).toSQL();
    expect(rendered.sql).toMatch(/MAX\(CASE/);
    expect(rendered.params).toEqual(
      expect.arrayContaining(["enterprise", ROADMAP_TIER_RANKS.enterprise, "free", ROADMAP_TIER_RANKS.free]),
    );
  });
});

describe("listRoadmapWithPrioritization — a page of items costs one tier query, and says when it could not weight", () => {
  it("resolves the whole page's tiers in one grouped query rather than one per item (BE-47)", async () => {
    const { service, select } = makeRoadmapService(
      [listRow(1, true), listRow(2, true), listRow(3, true)],
      [{ itemId: 1, linkedFeedbackCount: 2, linkedAccountCount: 2, topTierRank: 3 }],
    );
    await service.listRoadmapWithPrioritization(ORG, { limit: 50 });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("returns the plain RICE score and declares no_linked_feedback for an item nothing links to", async () => {
    const { service } = makeRoadmapService([listRow(2, true)], []);
    const page = await service.listRoadmapWithPrioritization(ORG, { limit: 50 });
    expect(page.data[0].prioritization.score).toBe(100);
    expect(page.data[0].tierWeighting).toMatchObject({
      tierWeighted: false,
      weightedScore: null,
      unweightedReason: "no_linked_feedback",
    });
  });

  it("weights by the highest tier the grouped query reported, proving the fallback is not universal", async () => {
    const { service } = makeRoadmapService(
      [listRow(1, true)],
      [{ itemId: 1, linkedFeedbackCount: 3, linkedAccountCount: 2, topTierRank: 3 }],
    );
    const page = await service.listRoadmapWithPrioritization(ORG, { limit: 50 });
    expect(page.data[0].tierWeighting).toMatchObject({
      tierWeighted: true,
      tier: "enterprise",
      weightedScore: 100 * ROADMAP_TIER_WEIGHTS.enterprise,
      unweightedReason: null,
    });
  });
});

describe("assertCrmOrganizationInOrg — a cross-tenant company id is a miss, not a denial (BE-91)", () => {
  it("throws NotFoundException rather than ForbiddenException when the id belongs to another tenant", async () => {
    const { db } = lookupSelect([]);
    await expect(assertCrmOrganizationInOrg(db, OTHER_ORG, 42)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("resolves for an id in the caller's tenant, proving the guard is not refusing every id", async () => {
    const { db, select } = lookupSelect([{ id: 42 }]);
    await expect(assertCrmOrganizationInOrg(db, ORG, 42)).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("costs no query when no company is named, so an unrelated patch is not charged a lookup", async () => {
    const { db, select } = lookupSelect([]);
    await expect(assertCrmOrganizationInOrg(db, ORG, null)).resolves.toBeUndefined();
    await expect(assertCrmOrganizationInOrg(db, ORG, undefined)).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });
});
