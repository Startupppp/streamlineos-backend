import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { TestRunsService } from "./test-runs.service";

describe("TestRunsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";
  const audit = { log: jest.fn() } as never;

  function makeDb(runRow: unknown | null) {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        testRuns: { findFirst: jest.fn().mockResolvedValue(runRow) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException for getRun when run belongs to a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new TestRunsService(db, audit);
    await expect(svc.getRun(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns run for the owning org (same-tenant control)", async () => {
    const run = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Run 1" };
    const db = makeDb(run);
    const svc = new TestRunsService(db, audit);
    const result = await svc.getRun(OWNER_ORG, 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});
