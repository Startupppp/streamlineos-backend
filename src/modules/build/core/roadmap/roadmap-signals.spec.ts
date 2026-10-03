import { sql } from "drizzle-orm";
import { orgWideRoadmapAccess, roadmapActor } from "../../__tests__/roadmap-access-double";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsRoadmapService } from "./projects-roadmap.service";
import {
  computeProgressPercent,
  resolveRoadmapDeliverySource,
  loadRoadmapDeliveryProgress,
  loadRoadmapDemandSignals,
  DELIVERY_PROGRESS_PERCENT_SCALE,
} from "./roadmap-delivery";
import { lifecycleAuditDouble } from "../../lifecycle/audit-double.spec-fixtures";

const ORG = "org-signals";
const OTHER_ORG = "org-intruder";

interface RoadmapRowShape {
  id: number;
  sortOrder: number;
  votes: number;
  projectId: number | null;
  epicTicketId: number | null;
  reach: number | null;
  impact: number | null;
  confidence: number | null;
  effort: number | null;
}

function roadmapRow(overrides: Partial<RoadmapRowShape> = {}): RoadmapRowShape {
  return {
    id: 7,
    sortOrder: 0,
    votes: 0,
    projectId: null,
    epicTicketId: null,
    reach: null,
    impact: null,
    confidence: null,
    effort: null,
    ...overrides,
  };
}

/**
 * One chainable stub for every `db.select` the service now issues.
 *
 * Scoring a row reads the linked accounts' tiers as well as the delivery and
 * demand aggregates, so a stub that answers only one shape leaves the other
 * reaching a real connection. Every builder method returns the node, the node
 * itself resolves to `aggregateRows`, and `groupBy` — which only the grouped
 * tier query calls — resolves to `tierRows`.
 */
function selectChain(parts: { aggregateRows?: unknown[]; tierRows?: unknown[] }) {
  const node: Record<string, unknown> = {};
  for (const method of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit"])
    node[method] = jest.fn(() => node);
  node.groupBy = jest.fn(() => Promise.resolve(parts.tierRows ?? []));
  node.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(parts.aggregateRows ?? []).then(resolve, reject);
  return jest.fn(() => node);
}

function makeService(parts: {
  findFirst?: jest.Mock;
  findMany?: jest.Mock;
  insert?: jest.Mock;
  update?: jest.Mock;
  aggregateRows?: unknown[];
  tierRows?: unknown[];
}) {
  const db = {
    query: {
      roadmapItems: {
        findFirst: parts.findFirst ?? jest.fn(),
        findMany: parts.findMany ?? jest.fn().mockResolvedValue([]),
      },
    },
    insert: parts.insert ?? jest.fn(),
    update: parts.update ?? jest.fn(),
    select: selectChain(parts),
  } as unknown as Db;
  return new ProjectsRoadmapService(db, lifecycleAuditDouble(), orgWideRoadmapAccess());
}

function insertCapture(returned: RoadmapRowShape) {
  const values = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([returned]) });
  const insert = jest.fn().mockReturnValue({ values });
  return { insert, values };
}

function updateCapture(returned: RoadmapRowShape) {
  const where = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([returned]) });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  const findFirst = jest.fn().mockResolvedValue({ version: 1 });
  return { update, set, findFirst };
}

describe("createRoadmap — the four RICE columns were published but unwritable; the input gap is closed", () => {
  it("writes reach, impact, confidence and effort into the insert values", async () => {
    const stored = roadmapRow({ reach: 500, impact: 3, confidence: 80, effort: 5 });
    const { insert, values } = insertCapture(stored);
    const service = makeService({ insert });

    await service.createRoadmap(roadmapActor(ORG), {
      title: "Bulk import",
      status: "planned",
      isPublic: true,
      sortOrder: 0,
      reach: 500,
      impact: 3,
      confidence: 80,
      effort: 5,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, reach: 500, impact: 3, confidence: 80, effort: 5 }),
    );
  });

  it("writes null rather than undefined when the four inputs are omitted", async () => {
    const { insert, values } = insertCapture(roadmapRow());
    const service = makeService({ insert });

    await service.createRoadmap(roadmapActor(ORG), {
      title: "Unscored",
      status: "planned",
      isPublic: true,
      sortOrder: 0,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ reach: null, impact: null, confidence: null, effort: null }),
    );
  });

  it("writes outcome into the insert values so a stated goal round-trips to the DB", async () => {
    const { insert, values } = insertCapture(roadmapRow());
    const service = makeService({ insert });

    await service.createRoadmap(roadmapActor(ORG), {
      title: "Reduce churn",
      status: "planned",
      isPublic: true,
      sortOrder: 0,
      outcome: "Churn falls below 3% within one quarter",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "Churn falls below 3% within one quarter" }),
    );
  });

  it("writes null outcome when the field is omitted — never undefined — so the column always has a value", async () => {
    const { insert, values } = insertCapture(roadmapRow());
    const service = makeService({ insert });

    await service.createRoadmap(roadmapActor(ORG), {
      title: "No goal yet",
      status: "planned",
      isPublic: true,
      sortOrder: 0,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: null }),
    );
  });

  it("returns the created row already carrying its computed prioritization", async () => {
    const stored = roadmapRow({ reach: 1000, impact: 3, confidence: 80, effort: 4 });
    const { insert } = insertCapture(stored);
    const created = await makeService({ insert }).createRoadmap(roadmapActor(ORG), {
      title: "Bulk import",
      status: "planned",
      isPublic: true,
      sortOrder: 0,
      reach: 1000,
      impact: 3,
      confidence: 80,
      effort: 4,
    });

    expect(created.prioritization).toMatchObject({ score: 600, isComplete: true });
  });
});

describe("createRoadmap — owner membership is validated against the actor's org before the row is written", () => {
  it("writes ownerMembershipId into the insert values when the membership exists in the same org", async () => {
    const { insert, values } = insertCapture(roadmapRow());
    const service = makeService({ insert, aggregateRows: [{ id: 42 }] });

    await service.createRoadmap(roadmapActor(ORG), {
      title: "Ship owner",
      status: "planned",
      isPublic: true,
      sortOrder: 0,
      ownerMembershipId: 42,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ ownerMembershipId: 42 }),
    );
  });

  it("throws BadRequestException when the membership belongs to a different org — cross-tenant owner is rejected cleanly, not as a 500", async () => {
    const service = makeService({ aggregateRows: [] });

    await expect(
      service.createRoadmap(roadmapActor(ORG), {
        title: "Cross-tenant attempt",
        status: "planned",
        isPublic: true,
        sortOrder: 0,
        ownerMembershipId: 99,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("updateRoadmap — RICE inputs round-trip through the update", () => {
  it("passes the four inputs to .set so an operator can score an existing item", async () => {
    const { update, set, findFirst } = updateCapture(roadmapRow({ reach: 10, impact: 1, confidence: 100, effort: 2 }));
    await makeService({ update, findFirst }).updateRoadmap(roadmapActor(ORG), 7, {
      version: 1,
      reach: 10,
      impact: 1,
      confidence: 100,
      effort: 2,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ reach: 10, impact: 1, confidence: 100, effort: 2 }),
    );
  });

  it("passes an explicit null through so a retracted guess is cleared, not ignored", async () => {
    const { update, set, findFirst } = updateCapture(roadmapRow());
    await makeService({ update, findFirst }).updateRoadmap(roadmapActor(ORG), 7, { version: 1, effort: null });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ effort: null }));
  });

  it("passes outcome through to .set so a stated goal can be updated on an existing item", async () => {
    const { update, set, findFirst } = updateCapture(roadmapRow());
    await makeService({ update, findFirst }).updateRoadmap(roadmapActor(ORG), 7, {
      version: 1,
      outcome: "Increase activation rate by 20%",
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "Increase activation rate by 20%" }),
    );
  });

  it("passes null outcome through so a previously set goal can be cleared", async () => {
    const { update, set, findFirst } = updateCapture(roadmapRow());
    await makeService({ update, findFirst }).updateRoadmap(roadmapActor(ORG), 7, { version: 1, outcome: null });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ outcome: null }));
  });

  it("returns a null score once an input is cleared, never the stale complete score", async () => {
    const { update, findFirst } = updateCapture(roadmapRow({ reach: 10, impact: 1, confidence: 100, effort: null }));
    const updated = await makeService({ update, findFirst }).updateRoadmap(roadmapActor(ORG), 7, { version: 1, effort: null });
    expect(updated.prioritization.score).toBeNull();
    expect(updated.prioritization.missingInputs).toEqual(["effort"]);
  });
});

describe("listRoadmapWithPrioritization — every row carries its score so the board can rank without a second fetch", () => {
  it("attaches prioritization to each row and keeps the cursor shape intact", async () => {
    const findMany = jest.fn().mockResolvedValue([
      roadmapRow({ id: 1, reach: 100, impact: 2, confidence: 50, effort: 1 }),
      roadmapRow({ id: 2 }),
    ]);
    const page = await makeService({ findMany }).listRoadmapWithPrioritization(roadmapActor(ORG), { limit: 50 });

    expect(page.data.map((row) => row.id)).toEqual([1, 2]);
    expect(page.data[0].prioritization.score).toBe(100);
    expect(page.data[1].prioritization.score).toBeNull();
    expect(page.data[1].prioritization.unavailableReason).toBe("missing_inputs");
  });

  it("leaves the raw pager untouched so the cursor contract is not reshaped by scoring", async () => {
    const findMany = jest.fn().mockResolvedValue([roadmapRow({ id: 1, sortOrder: 1 })]);
    const page = await makeService({ findMany }).listRoadmap(ORG, { limit: 50 });
    expect(page.data[0]).not.toHaveProperty("prioritization");
  });
});

describe("getRoadmapSignals — cross-tenant ids are a miss, not a denial (BE-91)", () => {
  it("throws NotFoundException when the item belongs to another org", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    await expect(makeService({ findFirst }).getRoadmapSignals(roadmapActor(OTHER_ORG), 7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("binds the caller org into the lookup predicate rather than trusting the id alone", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    await expect(makeService({ findFirst }).getRoadmapSignals(roadmapActor(OTHER_ORG), 7)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("returns signals for an item that is in the caller org, proving the guard is not denying everything", async () => {
    const findFirst = jest.fn().mockResolvedValue(
      roadmapRow({ id: 7, votes: 12, reach: 100, impact: 2, confidence: 50, effort: 1 }),
    );
    const signals = await makeService({
      findFirst,
      aggregateRows: [{ linkedFeedbackCount: 4, openLinkedFeedbackCount: 3 }],
    }).getRoadmapSignals(roadmapActor(ORG), 7);

    expect(signals.itemId).toBe(7);
    expect(signals.prioritization.score).toBe(100);
    expect(signals.demand).toEqual({ votes: 12, linkedFeedbackCount: 4, openLinkedFeedbackCount: 3 });
    expect(signals.delivery.source).toBe("none");
    expect(signals.delivery.progressPercent).toBeNull();
  });
});

describe("resolveRoadmapDeliverySource — the roadmap-to-project-work link", () => {
  it("prefers the epic ticket when both links are present", () => {
    expect(resolveRoadmapDeliverySource({ projectId: 3, epicTicketId: 9 })).toBe("epic_ticket");
  });

  it("falls back to the project when only projectId is set", () => {
    expect(resolveRoadmapDeliverySource({ projectId: 3, epicTicketId: null })).toBe("project");
  });

  it("reports none when the item links to no delivery work at all", () => {
    expect(resolveRoadmapDeliverySource({ projectId: null, epicTicketId: null })).toBe("none");
  });
});

describe("computeProgressPercent — progress from linked project work", () => {
  it("reports the completed share of the counted tickets", () => {
    expect(computeProgressPercent(3, 4)).toBe(75);
    expect(computeProgressPercent(0, 4)).toBe(0);
    expect(computeProgressPercent(4, 4)).toBe(DELIVERY_PROGRESS_PERCENT_SCALE);
  });

  it("reports null rather than zero percent when nothing is linked, so empty is not read as stalled", () => {
    expect(computeProgressPercent(0, 0)).toBeNull();
  });

  it("never divides by a negative or zero denominator", () => {
    expect(computeProgressPercent(2, -1)).toBeNull();
  });
});

describe("loadRoadmapDeliveryProgress — an unlinked item costs no query", () => {
  it("returns the empty progress shape without touching the database", async () => {
    const select = jest.fn();
    const db = { select } as unknown as Db;
    const progress = await loadRoadmapDeliveryProgress(db, ORG, {
      projectId: null,
      epicTicketId: null,
    }, sql`true`);
    expect(select).not.toHaveBeenCalled();
    expect(progress).toEqual({
      projectId: null,
      epicTicketId: null,
      source: "none",
      linkedTicketCount: 0,
      countedTicketCount: 0,
      completedTicketCount: 0,
      progressPercent: null,
    });
  });

  it("does issue a query when the item links to an epic, proving the short-circuit is not universal", async () => {
    const where = jest.fn().mockResolvedValue([
      { linkedTicketCount: 4, countedTicketCount: 4, completedTicketCount: 1 },
    ]);
    const select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ leftJoin: jest.fn().mockReturnValue({ where }) }),
    });
    const db = { select } as unknown as Db;
    const progress = await loadRoadmapDeliveryProgress(db, ORG, {
      projectId: null,
      epicTicketId: 42,
    }, sql`true`);
    expect(select).toHaveBeenCalledTimes(1);
    expect(progress).toMatchObject({ source: "epic_ticket", progressPercent: 25 });
  });
});

describe("loadRoadmapDemandSignals — linked feedback is the one live demand signal", () => {
  it("returns zero counts when the aggregate yields no row, never undefined", async () => {
    const select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    });
    const db = { select } as unknown as Db;
    await expect(loadRoadmapDemandSignals(db, ORG, 7, 5)).resolves.toEqual({
      votes: 5,
      linkedFeedbackCount: 0,
      openLinkedFeedbackCount: 0,
    });
  });

  it("passes the roadmap item's own vote tally through, which has a live writer on the public board", async () => {
    const select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ linkedFeedbackCount: 2, openLinkedFeedbackCount: 1 }]),
      }),
    });
    const db = { select } as unknown as Db;
    await expect(loadRoadmapDemandSignals(db, ORG, 7, 5)).resolves.toEqual({
      votes: 5,
      linkedFeedbackCount: 2,
      openLinkedFeedbackCount: 1,
    });
  });
});
