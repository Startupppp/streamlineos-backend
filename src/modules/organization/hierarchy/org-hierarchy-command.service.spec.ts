import type { Db } from "../../../db/drizzle.module";
import { runWithTenantContext, type TenantTx } from "../../../common/tenant";
import { OrgHierarchyCommandService } from "./org-hierarchy-command.service";
import type { OrgHierarchyDependenciesService } from "./org-hierarchy-dependencies.service";

describe("OrgHierarchyCommandService", () => {
  const orgId = "org-1";
  const unitId = "00000000-0000-0000-0000-000000000001";
  let rows: Array<{ id: string }>;
  let events: string[];
  let execute: jest.Mock;
  let forLock: jest.Mock;
  let transaction: jest.Mock;
  let dependencies: {
    assertCanArchive: jest.Mock;
    assertCanRetire: jest.Mock;
  };
  let service: OrgHierarchyCommandService;

  beforeEach(() => {
    rows = [{ id: unitId }];
    events = [];
    execute = jest.fn().mockImplementation(async () => {
      events.push("advisory-lock");
      return [];
    });
    const limit = jest.fn().mockImplementation(async () => {
      events.push("row-lock");
      return rows;
    });
    forLock = jest.fn().mockReturnValue({ limit });
    transaction = jest
      .fn()
      .mockImplementation(async (callback: (tx: TenantTx) => Promise<unknown>) =>
        callback({ execute } as unknown as TenantTx),
      );
    const db = {
      execute,
      transaction,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ for: forLock }),
        }),
      }),
    } as unknown as Db;
    dependencies = {
      assertCanArchive: jest.fn().mockImplementation(async () => {
        events.push("dependency-check");
      }),
      assertCanRetire: jest.fn().mockImplementation(async () => {
        events.push("dependency-check");
      }),
    };
    service = new OrgHierarchyCommandService(
      db,
      dependencies as unknown as OrgHierarchyDependenciesService,
    );
  });

  it("locks, rechecks archive dependencies, then mutates in that order", async () => {
    const mutation = jest.fn().mockImplementation(async () => {
      events.push("mutation");
      return { id: unitId };
    });

    const result = await runWithTenantContext(
      {
        orgId,
        audience: "INTERNAL",
        tx: {} as TenantTx,
        afterCommit: [],
      },
      () => service.run(orgId, unitId, "DEPARTMENT", "archive", mutation),
    );

    expect(result).toEqual({ id: unitId });
    expect(events).toEqual([
      "advisory-lock",
      "row-lock",
      "dependency-check",
      "mutation",
    ]);
    expect(forLock).toHaveBeenCalledWith("update");
    expect(dependencies.assertCanArchive).toHaveBeenCalledWith(
      orgId,
      unitId,
      "DEPARTMENT",
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it("opens a tenant transaction for non-request callers", async () => {
    await service.run(orgId, unitId, "LOCATION", "retire", async () => true);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(dependencies.assertCanRetire).toHaveBeenCalledWith(
      orgId,
      unitId,
      "LOCATION",
    );
  });

  it("does not check dependencies or mutate when the target is absent", async () => {
    rows = [];
    const mutation = jest.fn();

    await expect(
      runWithTenantContext(
        {
          orgId,
          audience: "INTERNAL",
          tx: {} as TenantTx,
          afterCommit: [],
        },
        () => service.run(orgId, unitId, "TEAM", "archive", mutation),
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(dependencies.assertCanArchive).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  it("rejects a command whose organization differs from the active tenant", async () => {
    await expect(
      runWithTenantContext(
        {
          orgId,
          audience: "INTERNAL",
          tx: {} as TenantTx,
          afterCommit: [],
        },
        () =>
          service.run(
            "org-2",
            unitId,
            "BUSINESS_UNIT",
            "archive",
            async () => true,
          ),
      ),
    ).rejects.toThrow("tenant does not match");

    expect(execute).not.toHaveBeenCalled();
  });
});
