import { CrmAutomationsService } from "./crm-automations.service";
import { encodeCursor } from "../../../common/pagination/cursor";
import type { Db } from "../../../db/drizzle.module";
import type { CrmAutomationRunnerService } from "../automation-studio/crm-automation-runner.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";

const ORG_ID = "org-1";
const RULE_ID = 4;

interface Harness {
  readonly service: CrmAutomationsService;
  readonly statements: () => number;
  readonly lastLimit: () => number | undefined;
}

function buildHarness(page: { rows: number; total: number }): Harness {
  let statements = 0;
  let lastLimit: number | undefined;

  const runRows = Array.from({ length: page.rows }, (_, i) => ({
    id: i + 1,
    orgId: ORG_ID,
    ruleId: RULE_ID,
    startedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
  }));

  function makeChain(result: unknown): Record<string, unknown> {
    const link: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "innerJoin", "leftJoin", "offset"])
      link[method] = jest.fn(() => link);
    link["limit"] = jest.fn((n: number) => {
      lastLimit = n;
      return link;
    });
    link["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return link;
  }

  let call = 0;
  const db = {
    select: jest.fn(() => {
      statements += 1;
      call += 1;
      if (call === 1) return makeChain([{ id: RULE_ID }]);
      if (call === 2) return makeChain(runRows);
      return makeChain([{ c: page.total }]);
    }),
  } as unknown as Db;

  return {
    service: new CrmAutomationsService(
      db,
      {} as unknown as CrmAutomationRunnerService,
      {} as unknown as PlanLimitsService,
    ),
    statements: () => statements,
    lastLimit: () => lastLimit,
  };
}

describe("automation run list — cursor pagination with optional first-page count", () => {
  it("returns total from a separate count statement on the first page", async () => {
    const harness = buildHarness({ rows: 20, total: 137 });

    const result = await harness.service.getRuns(ORG_ID, RULE_ID);

    expect(result.total).toBe(137);
    expect(harness.statements()).toBe(3);
  });

  it("never leaks the count field onto run items", async () => {
    const harness = buildHarness({ rows: 3, total: 3 });

    const result = await harness.service.getRuns(ORG_ID, RULE_ID);

    for (const run of result.runs) {
      expect(run).not.toHaveProperty("c");
      expect(run).toHaveProperty("id");
    }
  });

  it("cursor page skips the count statement", async () => {
    const first = buildHarness({ rows: 20, total: 4_000 });
    const cursor = buildHarness({ rows: 20, total: 0 });

    await first.service.getRuns(ORG_ID, RULE_ID);
    const validCursor = encodeCursor({ sortValue: "2024-01-01T00:00:00.000Z", id: "1" });
    await cursor.service.getRuns(ORG_ID, RULE_ID, validCursor);

    expect(first.statements()).toBe(3);
    expect(cursor.statements()).toBe(2);
  });

  it("reports zero total and empty runs for an empty first page", async () => {
    const harness = buildHarness({ rows: 0, total: 0 });

    const result = await harness.service.getRuns(ORG_ID, RULE_ID);

    expect(result).toEqual({ runs: [], hasMore: false, nextCursor: null, total: 0 });
    expect(harness.statements()).toBe(3);
  });

  it("fetches limit+1 rows to detect hasMore without a second count", async () => {
    const harness = buildHarness({ rows: 20, total: 137 });

    await harness.service.getRuns(ORG_ID, RULE_ID);

    expect(harness.lastLimit()).toBe(21);
  });
});
