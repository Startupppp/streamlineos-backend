import { NotFoundException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { KbContentHealthService } from "./kb-content-health.service";
import { KbContentHealthScannerService } from "./kb-content-health-scanner.service";
import type { ContentHealthSignalsQuery } from "./dto/kb-content-health.schemas";

const dialect = new PgDialect();

function render(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  try {
    return dialect.sqlToQuery(v as SQL).sql;
  } catch {
    return "";
  }
}

function makeCapturingDb(rows: unknown[] = []): { db: Db; wheres: unknown[] } {
  const wheres: unknown[] = [];
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn().mockResolvedValue(rows);
  chain.where = jest.fn((clause: unknown) => {
    wheres.push(clause);
    return chain;
  });
  const db = { select: jest.fn(() => chain) } as unknown as Db;
  return { db, wheres };
}

function makeAssignDb(options: {
  pageVisible?: boolean;
  existingOpen?: boolean;
  returnedItem?: Record<string, unknown>;
}): Db {
  const { pageVisible = true, existingOpen = false, returnedItem } = options;

  const baseItem = returnedItem ?? {
    id: 10,
    orgId: "org-1",
    pageId: 1,
    kind: "unowned",
    ruleVersion: 1,
    state: "open",
    assigneeMembershipId: 5,
    dueAt: null,
    detectedAt: new Date(),
    resolvedAt: null,
    dismissedAt: null,
    dismissedReason: null,
    dismissalExpiresAt: null,
    impact: 0,
    evidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const selectChain: Record<string, jest.Mock> = {};
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => Promise.resolve(pageVisible ? [{ id: 1 }] : []));

  const updateReturning = jest.fn().mockResolvedValue(existingOpen ? [baseItem] : []);
  const updateWhere = jest.fn(() => ({ returning: updateReturning }));
  const updateSet = jest.fn(() => ({ where: updateWhere }));

  const insertReturning = jest.fn().mockResolvedValue([baseItem]);
  const insertValues = jest.fn(() => ({ returning: insertReturning }));

  return {
    select: jest.fn(() => selectChain),
    update: jest.fn(() => ({ set: updateSet })),
    insert: jest.fn(() => ({ values: insertValues })),
  } as unknown as Db;
}

function makeBulkRepairDb(options: {
  visiblePageIds?: number[];
  existingItems?: { pageId: number; state: string }[];
}): Db {
  const { visiblePageIds = [1, 2], existingItems = [] } = options;

  let selectCallCount = 0;
  const selectChain: Record<string, jest.Mock> = {};
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => {
    selectCallCount++;
    if (selectCallCount === 1) {
      return Promise.resolve(visiblePageIds.map((id) => ({ id })));
    }
    return Promise.resolve(existingItems);
  });

  const insertValues = jest.fn(() => Promise.resolve([]));

  const updateWhere = jest.fn(() => Promise.resolve([]));
  const updateSet = jest.fn(() => ({ where: updateWhere }));

  return {
    select: jest.fn(() => selectChain),
    insert: jest.fn(() => ({ values: insertValues })),
    update: jest.fn(() => ({ set: updateSet })),
  } as unknown as Db;
}

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
};

function makeUser(orgId = "org-1") {
  return { orgId, userId: "user-1", principal: { kind: "human-session", membershipId: 1 } } as never;
}

describe("KbContentHealthService — contradictory_claim signal", () => {
  afterEach(() => jest.resetAllMocks());

  it("returns the page for a contradictory_claim signal when a health item row marks it open, so the preset has a consumer side", async () => {
    const { db } = makeCapturingDb([{
      id: 1,
      title: "Page One",
      spaceId: null,
      status: "published",
      ownerMembershipId: null,
      updatedAt: new Date(),
      nextReviewAt: null,
      impact: 0,
    }]);
    const svc = new KbContentHealthService(db, auth as never);
    const query: ContentHealthSignalsQuery = {
      signalType: "contradictory_claim",
      limit: 10,
      afterId: undefined,
      spaceId: undefined,
      ownerMembershipId: undefined,
    };
    const result = await svc.signals(makeUser(), query);
    expect(result.data).toHaveLength(1);
  });

  it("returns empty for contradictory_claim when no health item rows exist, so the signal is only as populated as the scanner makes it", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new KbContentHealthService(db, auth as never);
    const query: ContentHealthSignalsQuery = {
      signalType: "contradictory_claim",
      limit: 10,
      afterId: undefined,
      spaceId: undefined,
      ownerMembershipId: undefined,
    };
    const result = await svc.signals(makeUser(), query);
    expect(result.data).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it("queries kb_health_items for the contradictory_claim predicate, not merely kb_pages fields, so the predicate is scanner-driven", async () => {
    const { db, wheres } = makeCapturingDb([]);
    const svc = new KbContentHealthService(db, auth as never);
    await svc.signals(makeUser(), {
      signalType: "contradictory_claim",
      limit: 10,
      afterId: undefined,
      spaceId: undefined,
      ownerMembershipId: undefined,
    });
    const rendered = wheres.map((w) => render(w)).join(" ");
    expect(rendered).toContain("kb_health_items");
    expect(rendered).toContain("state");
  });

  it("counts nine signal types including contradictory_claim, so the counts list has grown from eight", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: 0 }]),
        }),
      }),
    } as unknown as Db;
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.counts(makeUser());
    expect(result.counts).toHaveLength(9);
    const kinds = result.counts.map((c) => c.signalType);
    expect(kinds).toContain("contradictory_claim");
  });
});

describe("KbContentHealthService — assign", () => {
  afterEach(() => jest.resetAllMocks());

  it("throws NotFoundException when the page is not visible, so assign cannot probe cross-tenant pages", async () => {
    const db = makeAssignDb({ pageVisible: false });
    const svc = new KbContentHealthService(db, auth as never);
    await expect(
      svc.assign(makeUser(), { pageId: 1, kind: "unowned", assigneeMembershipId: 5 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns the updated item when an open item already exists, updating assignee in-place", async () => {
    const db = makeAssignDb({ pageVisible: true, existingOpen: true });
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.assign(makeUser(), { pageId: 1, kind: "unowned", assigneeMembershipId: 5 });
    expect(result.assigneeMembershipId).toBe(5);
    expect(result.state).toBe("open");
  });

  it("creates a new health item when no open item exists, so assign works as an upsert without requiring the scanner to have run first", async () => {
    const db = makeAssignDb({ pageVisible: true, existingOpen: false });
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.assign(makeUser(), { pageId: 1, kind: "unowned", assigneeMembershipId: 5 });
    expect(result.assigneeMembershipId).toBe(5);
    const insertMock = (db as unknown as { insert: jest.Mock }).insert;
    expect(insertMock).toHaveBeenCalledTimes(1);
  });
});

describe("KbContentHealthService — bulkRepair", () => {
  afterEach(() => jest.resetAllMocks());

  it("skips pages the viewer cannot see, so bulk repair cannot touch cross-tenant items", async () => {
    const db = makeBulkRepairDb({ visiblePageIds: [1], existingItems: [] });
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.bulkRepair(makeUser(), {
      pageIds: [1, 2],
      kind: "unowned",
      repairAction: "assign_owner",
      assigneeMembershipId: 5,
    });
    const skipped = result.results.filter((r) => r.outcome === "skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.pageId).toBe(2);
  });

  it("marks already-resolved items without re-applying the repair, making the operation idempotent", async () => {
    const db = makeBulkRepairDb({
      visiblePageIds: [1, 2],
      existingItems: [{ pageId: 1, state: "resolved" }],
    });
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.bulkRepair(makeUser(), {
      pageIds: [1, 2],
      kind: "unowned",
      repairAction: "assign_owner",
      assigneeMembershipId: 5,
    });
    const already = result.results.filter((r) => r.outcome === "already_resolved");
    const applied = result.results.filter((r) => r.outcome === "applied");
    expect(already).toHaveLength(1);
    expect(applied).toHaveLength(1);
  });

  it("reports a per-item outcome for each pageId, so the caller knows which repairs succeeded and which did not", async () => {
    const db = makeBulkRepairDb({ visiblePageIds: [1, 2, 3], existingItems: [] });
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.bulkRepair(makeUser(), {
      pageIds: [1, 2, 3],
      kind: "empty",
      repairAction: "mark_needs_content",
    });
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.outcome === "applied")).toBe(true);
  });
});

describe("KbContentHealthService — bulkRepair cannot publish a page", () => {
  afterEach(() => jest.resetAllMocks());

  it("does not accept a 'publish' repairAction because no such value exists in the enum, enforcing no-auto-publish at the schema level", () => {
    const { bulkRepairBodySchema } = require("./dto/kb-content-health.schemas");
    const result = bulkRepairBodySchema.safeParse({
      pageIds: [1],
      kind: "unowned",
      repairAction: "publish",
    });
    expect(result.success).toBe(false);
  });

  it("only accepts assign_owner, request_review, mark_needs_content as repair actions, leaving publish outside the allowed set", () => {
    const { bulkRepairBodySchema } = require("./dto/kb-content-health.schemas");
    const allowed = ["assign_owner", "request_review", "mark_needs_content"];
    for (const action of allowed) {
      const r = bulkRepairBodySchema.safeParse({ pageIds: [1], kind: "unowned", repairAction: action });
      expect(r.success).toBe(true);
    }
    const disallowed = ["publish", "set_published", "approve", "go_live"];
    for (const action of disallowed) {
      const r = bulkRepairBodySchema.safeParse({ pageIds: [1], kind: "unowned", repairAction: action });
      expect(r.success).toBe(false);
    }
  });
});

describe("KbContentHealthScannerService — producers for all nine kinds", () => {
  afterEach(() => jest.resetAllMocks());

  it("recordContradiction writes an open health item with kind=contradictory_claim and the supplied evidence — removing this test breaks the producer contract", async () => {
    const insertValues = jest.fn().mockReturnValue({
      onConflictDoUpdate: jest.fn().mockResolvedValue([]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([{ id: 1, impact: 40 }]) }),
      }),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
    } as unknown as Db;
    const scanner = new KbContentHealthScannerService(db);
    await scanner.recordContradiction("org-1", 1, { pageId: 2, reason: "conflicts with page 2" });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "contradictory_claim", pageId: 1 }),
    );
  });

  it("scan() calls scanContradictions so contradictory_claim is produced on the sweep path, not only via the API — removing this test breaks the nine-preset contract", async () => {
    const insertChain = {
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
        catch: jest.fn().mockResolvedValue(undefined),
      }),
      onConflictDoNothing: jest.fn().mockReturnValue({ catch: jest.fn().mockResolvedValue(undefined) }),
    };
    const executeSpy = jest.fn().mockResolvedValue([
      { page_id: 10, other_id: 20, title: "API Rate Limits Guide", space_id: 1 },
    ]);
    const db = {
      insert: jest.fn().mockReturnValue(insertChain),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ catch: jest.fn().mockResolvedValue(undefined) }) }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
            then: (resolve: (v: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
          }),
        }),
      }),
      execute: executeSpy,
    } as unknown as Db;

    const scanner = new KbContentHealthScannerService(db);
    await scanner.scan("org-1");

    expect(executeSpy).toHaveBeenCalled();
    const callArg = render(executeSpy.mock.calls[0]?.[0]);
    expect(callArg).toMatch(/split_part|contradictory_claim|title_prefix/i);
  });
});

describe("KbContentHealthService — evidence endpoint", () => {
  afterEach(() => jest.resetAllMocks());

  it("throws NotFoundException when the page is not visible, so evidence cannot be used to probe cross-tenant pages", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
      }),
    } as unknown as Db;
    const svc = new KbContentHealthService(db, auth as never);
    await expect(
      svc.getEvidence(makeUser(), { pageId: 1, kind: "unowned" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns the evidence JSON from the health item row when one exists, linking the item to its versioned detection data", async () => {
    const evidencePayload = { reason: "no owner for 180 days", detectedByRuleVersion: 1 };
    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 1 }]);
            return Promise.resolve([{
              pageId: 1,
              kind: "unowned",
              ruleVersion: 1,
              evidence: evidencePayload,
              detectedAt: new Date("2025-01-01T00:00:00.000Z"),
            }]);
          }),
        }),
      })),
    } as unknown as Db;
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.getEvidence(makeUser(), { pageId: 1, kind: "unowned" });
    expect(result.evidence).toEqual(evidencePayload);
    expect(result.ruleVersion).toBe(1);
  });

  it("returns an empty evidence object when no health item row exists, so the evidence endpoint never throws for a valid page", async () => {
    let selectCallCount = 0;
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => {
            selectCallCount++;
            if (selectCallCount === 1) return Promise.resolve([{ id: 1 }]);
            return Promise.resolve([]);
          }),
        }),
      })),
    } as unknown as Db;
    const svc = new KbContentHealthService(db, auth as never);
    const result = await svc.getEvidence(makeUser(), { pageId: 1, kind: "unowned" });
    expect(result.evidence).toEqual({});
  });
});
