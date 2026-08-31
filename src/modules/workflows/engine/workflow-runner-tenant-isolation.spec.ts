jest.mock("../../../common/tenant/for-each-org", () => ({
  forEachOrg: jest.fn(),
}));

import { forEachOrg } from "../../../common/tenant/for-each-org";
import type { ForEachOrgResult } from "../../../common/tenant/for-each-org";
import type { Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import { WorkflowRunnerService } from "./workflow-runner.service";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("WorkflowRunnerService — cross-tenant isolation", () => {
  const ORG_A = "org-a";
  const ORG_B = "org-b";

  const mockedForEachOrg = forEachOrg as jest.MockedFunction<typeof forEachOrg>;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  function makeTx(wheres: unknown[]) {
    return {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Promise.resolve();
          }),
        }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Object.assign(Promise.resolve([]), {
              limit: jest.fn().mockResolvedValue([]),
            });
          }),
        }),
      }),
    } as unknown as TenantTx;
  }

  it("scopes sweep queries to the correct org (tenant isolation — different orgs don't share data)", async () => {
    const wheresA: unknown[] = [];
    const txA = makeTx(wheresA);

    mockedForEachOrg.mockImplementation(async (_db, _key, cb) => {
      await cb(txA, ORG_A);
      return { organizations: 1, succeeded: 1, failed: 0 } satisfies ForEachOrgResult;
    });

    const svc = new WorkflowRunnerService({} as unknown as Db, {} as never, {} as never);
    await svc.sweep();

    expect(wheresA.length).toBeGreaterThan(0);
    const vals = wheresA.flatMap(w => sqlValues(w));
    expect(vals).toContain(ORG_A);
    expect(vals).not.toContain(ORG_B);
  });

  it("returns sweep totals (same-tenant control)", async () => {
    mockedForEachOrg.mockImplementation(async (_db, _key, _cb) => {
      return { organizations: 0, succeeded: 0, failed: 0 } satisfies ForEachOrgResult;
    });

    const svc = new WorkflowRunnerService({} as unknown as Db, {} as never, {} as never);
    const result = await svc.sweep();

    expect(result).toBeDefined();
    expect(result).toHaveProperty("claimed");
  });
});
