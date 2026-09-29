import type { Db } from "../../../db/drizzle.module";
import { RunsService } from "./runs.service";

interface SelectScript {
  readonly existingRuns: unknown[];
  readonly activePolicyVersions: unknown[];
}

function makeDb(script: SelectScript) {
  const inserted = jest.fn().mockResolvedValue([{ id: 99 }]);
  const selects: unknown[][] = [script.existingRuns, script.activePolicyVersions];
  let call = 0;

  function builder() {
    const rows = selects[call] ?? [];
    const self: Record<string, unknown> = {};
    for (const method of ["from", "where", "innerJoin", "orderBy", "groupBy"])
      self[method] = jest.fn(() => self);
    self["limit"] = jest.fn(() => {
      call += 1;
      return Promise.resolve(rows);
    });
    return self;
  }

  const db = {
    select: jest.fn(() => builder()),
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
    },
    insert: jest.fn(() => ({
      values: jest.fn(() => ({ returning: inserted })),
    })),
  } as unknown as Db;

  return { db, inserted };
}

function makeService(db: Db): RunsService {
  return new RunsService(
    db,
    { log: jest.fn() } as never,
    { getEntity: jest.fn(), ensurePeriod: jest.fn(), assertNoCountryContamination: jest.fn() } as never,
    {} as never,
    {} as never,
  );
}

const ORG = "org-1";
const USER = "user-1";

describe("a payroll run cannot exist before payroll is set up (BUG-001)", () => {
  it("creates the run when the org has an ACTIVE policy version, so the refusal below is not the only reachable branch", async () => {
    const { db, inserted } = makeDb({ existingRuns: [], activePolicyVersions: [{ id: 12 }] });

    await expect(makeService(db).createRun(ORG, USER, "2026-09")).resolves.toEqual({
      ok: true,
      runId: 99,
    });
    expect(inserted).toHaveBeenCalledTimes(1);
  });

  it("refuses with no_active_policy when the org has no ACTIVE policy version", async () => {
    const { db } = makeDb({ existingRuns: [], activePolicyVersions: [] });

    await expect(makeService(db).createRun(ORG, USER, "2026-09")).resolves.toEqual({
      ok: false,
      reason: "no_active_policy",
    });
  });

  it("writes no payroll_runs row when it refuses, so Settings and the runs list cannot disagree about setup", async () => {
    const { db, inserted } = makeDb({ existingRuns: [], activePolicyVersions: [] });

    await makeService(db).createRun(ORG, USER, "2026-09");

    expect(inserted).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("still reports an existing run as exists rather than as missing setup", async () => {
    const { db } = makeDb({ existingRuns: [{ id: 3, entityId: null }], activePolicyVersions: [] });

    await expect(makeService(db).createRun(ORG, USER, "2026-09")).resolves.toEqual({
      ok: false,
      reason: "exists",
    });
  });
});
