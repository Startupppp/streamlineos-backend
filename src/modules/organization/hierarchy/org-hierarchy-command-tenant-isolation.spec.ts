import { OrgHierarchyCommandService } from "./org-hierarchy-command.service";
import type { Db } from "../../../db/drizzle.module";
import { NotFoundException } from "@nestjs/common";

jest.mock("../../../common/tenant", () => ({
  getTenantContext: jest.fn().mockReturnValue(null),
  withTenant: jest.fn((_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db)),
  runWithTenantContext: jest.fn((_orgId: string, fn: () => Promise<unknown>) => fn()),
}));

describe("OrgHierarchyCommandService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const UNIT_ID = "unit-123";

  function makeService(selectRows: unknown[]) {
    const forClause = jest.fn();
    const limit = jest.fn().mockResolvedValue(selectRows);
    const where = jest.fn().mockReturnValue({ for: forClause, limit });
    forClause.mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const execute = jest.fn().mockResolvedValue([{ '?column?': null }]);
    const db = {
      select: jest.fn().mockReturnValue({ from }),
      execute,
    } as unknown as Db;
    const deps = { assertCanArchive: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrgHierarchyCommandService(db, deps as never);
    return { svc, where };
  }

  it("throws NotFoundException when the unit belongs to a different org (cross-tenant isolation)", async () => {
    const { svc } = makeService([]);
    const mutation = jest.fn().mockResolvedValue({ success: true });
    await expect(
      svc.run(ATTACKER, UNIT_ID, "BRANCH", mutation),
    ).rejects.toThrow(NotFoundException);
    expect(mutation).not.toHaveBeenCalled();
  });

  it("executes mutation for the owning org when unit found (control)", async () => {
    const { svc } = makeService([{ id: UNIT_ID }]);
    const mutation = jest.fn().mockResolvedValue({ success: true });
    await expect(
      svc.run(OWNER, UNIT_ID, "BRANCH", mutation),
    ).resolves.toEqual({ success: true });
    expect(mutation).toHaveBeenCalled();
  });
});
