import type { Db } from "../../../db/drizzle.module";
import {
  OrgHierarchyTreeSourceService,
  type OrgTreeRow,
} from "./org-hierarchy-tree-source.service";

const orgId = "org-1";

function makeUnit(
  unitId: string,
  kind: OrgTreeRow["kind"],
  parentId: string | null,
): OrgTreeRow {
  return {
    id: unitId,
    orgId,
    kind,
    parentId,
    name: unitId,
    code: unitId.toUpperCase(),
    description: null,
    headUserId: null,
    status: "ACTIVE",
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
  };
}

function profileQuery(result: unknown) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(result),
      }),
    }),
  };
}

function profileFailureQuery(error: unknown) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockRejectedValue(error),
      }),
    }),
  };
}

function joinChain(result: unknown) {
  const where = jest.fn().mockReturnValue({
    limit: jest.fn().mockResolvedValue(result),
  });
  const leftJoin: jest.Mock = jest.fn();
  leftJoin.mockReturnValue({ leftJoin, where });
  return { leftJoin, where };
}

function adjacencyQuery(result: unknown) {
  return { from: jest.fn().mockReturnValue(joinChain(result)) };
}

function closureQuery(result: unknown) {
  return { from: jest.fn().mockReturnValue(joinChain(result)) };
}

describe("OrgHierarchyTreeSourceService", () => {
  let selectQuery: jest.Mock;
  let executeQuery: jest.Mock;
  let service: OrgHierarchyTreeSourceService;

  // The service asks the catalog whether a relation exists before querying it, so
  // every case here must say which relations are deployed. Default: both are.
  beforeEach(() => {
    selectQuery = jest.fn();
    executeQuery = jest.fn().mockResolvedValue([{ present: true }]);
    service = new OrgHierarchyTreeSourceService({
      select: selectQuery,
      execute: executeQuery,
    } as unknown as Db);
  });

  it("uses the tenant migration profile and revision", async () => {
    selectQuery.mockReturnValue(
      profileQuery([{ mode: "CLOSURE", revision: 7 }]),
    );

    await expect(service.resolveReadProfile(orgId)).resolves.toEqual({
      mode: "CLOSURE",
      revision: 7,
    });
  });

  it("uses adjacency when the profile relation has not been deployed", async () => {
    executeQuery.mockResolvedValue([{ present: false }]);

    await expect(service.resolveReadProfile(orgId)).resolves.toEqual({
      mode: "ADJACENCY",
      revision: 0,
    });
    // The point of the catalog probe: the absent table is never queried, so the
    // surrounding tenant transaction is never aborted.
    expect(selectQuery).not.toHaveBeenCalled();
  });

  // The shape production actually throws: Drizzle wraps the driver error, so the
  // SQLSTATE is on `cause`. Asserting only the bare shape let a live 500 through.
  it("uses adjacency when the driver error arrives wrapped by Drizzle", async () => {
    const wrapped = Object.assign(new Error("Failed query: select ..."), {
      cause: { name: "PostgresError", code: "42P01" },
    });
    selectQuery.mockReturnValue(profileFailureQuery(wrapped));

    await expect(service.resolveReadProfile(orgId)).resolves.toEqual({
      mode: "ADJACENCY",
      revision: 0,
    });
  });

  it("serves verified closure rows in closure mode", async () => {
    const businessUnit = makeUnit("business-unit-1", "BUSINESS_UNIT", null);
    const branch = makeUnit("branch-1", "BRANCH", businessUnit.id);
    selectQuery.mockReturnValue(
      closureQuery([
        {
          ...businessUnit,
          closureSelfId: businessUnit.id,
          closureParentId: null,
        },
        {
          ...branch,
          closureSelfId: branch.id,
          closureParentId: businessUnit.id,
        },
      ]),
    );

    await expect(
      service.loadTreeRows(orgId, { mode: "CLOSURE", revision: 3 }),
    ).resolves.toEqual([businessUnit, branch]);
    expect(selectQuery).toHaveBeenCalledTimes(1);
  });

  it("falls back to adjacency when the closure projection is incomplete", async () => {
    const businessUnit = makeUnit("business-unit-1", "BUSINESS_UNIT", null);
    selectQuery
      .mockReturnValueOnce(
        closureQuery([
          {
            ...businessUnit,
            closureSelfId: null,
            closureParentId: null,
          },
        ]),
      )
      .mockReturnValueOnce(adjacencyQuery([businessUnit]));

    await expect(
      service.loadTreeRows(orgId, { mode: "CLOSURE", revision: 3 }),
    ).resolves.toEqual([businessUnit]);
    expect(selectQuery).toHaveBeenCalledTimes(2);
  });

  it("validates closure in shadow mode while serving adjacency", async () => {
    const adjacencyBusinessUnit = makeUnit(
      "business-unit-1",
      "BUSINESS_UNIT",
      null,
    );
    const closureBusinessUnit = {
      ...adjacencyBusinessUnit,
      name: "Closure shadow value",
      closureSelfId: adjacencyBusinessUnit.id,
      closureParentId: null,
    };
    selectQuery
      .mockReturnValueOnce(adjacencyQuery([adjacencyBusinessUnit]))
      .mockReturnValueOnce(closureQuery([closureBusinessUnit]));

    await expect(
      service.loadTreeRows(orgId, {
        mode: "SHADOW_CLOSURE",
        revision: 2,
      }),
    ).resolves.toEqual([adjacencyBusinessUnit]);
    expect(selectQuery).toHaveBeenCalledTimes(2);
  });
});
