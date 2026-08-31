import { CrmAutomationsService } from "./crm-automations.service";
import type { Db } from "../../../db/drizzle.module";
import type { CrmAutomationRunnerService } from "../automation-studio/crm-automation-runner.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";

// The total used to come from a second statement that selected one id per run and took the array's length.

const ORG_ID = "org-1";
const RULE_ID = 4;

interface Harness {
  readonly service: CrmAutomationsService;
  readonly statements: () => number;
  readonly lastOffset: () => number | undefined;
}

function buildHarness(page: { rows: number; total: number }): Harness {
  let statements = 0;
  let lastOffset: number | undefined;

  const runRows = Array.from({ length: page.rows }, (_, i) => ({
    id: i + 1,
    orgId: ORG_ID,
    ruleId: RULE_ID,
    startedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
    total: String(page.total),
  }));

  const chain = (result: unknown): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "innerJoin", "leftJoin"])
      link[method] = jest.fn(() => link);
    link["limit"] = jest.fn(() => link);
    link["offset"] = jest.fn((value: number) => {
      lastOffset = value;
      return Promise.resolve(result);
    });
    link["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return link;
  };

  let call = 0;
  const db = {
    select: jest.fn(() => {
      statements += 1;
      call += 1;
      // The rule-ownership probe is the first statement; the page is the second.
      return chain(call === 1 ? [{ id: RULE_ID }] : runRows);
    }),
  } as unknown as Db;

  return {
    service: new CrmAutomationsService(
      db,
      {} as unknown as CrmAutomationRunnerService,
      {} as unknown as PlanLimitsService,
    ),
    statements: () => statements,
    lastOffset: () => lastOffset,
  };
}

describe("automation run list — the total costs no extra round trip", () => {
  it("reads the total out of the page query rather than a second statement", async () => {
    const harness = buildHarness({ rows: 20, total: 137 });

    const result = await harness.service.getRuns(ORG_ID, RULE_ID, 1);

    expect(result.total).toBe(137);
    expect(harness.statements()).toBe(2);
  });

  it("never returns the window column as part of a run", async () => {
    const harness = buildHarness({ rows: 3, total: 3 });

    const result = await harness.service.getRuns(ORG_ID, RULE_ID, 1);

    for (const run of result.runs) expect(run).not.toHaveProperty("total");
  });

  it("issues the same number of statements for a page of 20 as for a page of 1", async () => {
    const small = buildHarness({ rows: 1, total: 1 });
    const full = buildHarness({ rows: 20, total: 4_000 });

    await small.service.getRuns(ORG_ID, RULE_ID, 1);
    await full.service.getRuns(ORG_ID, RULE_ID, 1);

    expect(full.statements()).toBe(small.statements());
  });

  it("reports zero for an empty first page without counting again", async () => {
    const harness = buildHarness({ rows: 0, total: 0 });

    const result = await harness.service.getRuns(ORG_ID, RULE_ID, 1);

    expect(result).toEqual({ runs: [], total: 0 });
    expect(harness.statements()).toBe(2);
  });

  it("still pages by twenty", async () => {
    const harness = buildHarness({ rows: 20, total: 137 });

    await harness.service.getRuns(ORG_ID, RULE_ID, 3);

    expect(harness.lastOffset()).toBe(40);
  });
});
