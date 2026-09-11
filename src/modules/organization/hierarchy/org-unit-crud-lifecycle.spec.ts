import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { OrgHierarchyBranchesService } from "./org-hierarchy-branches.service";
import { OrgHierarchyBusinessUnitsService } from "./org-hierarchy-business-units.service";
import { OrgUnitCrudService } from "./org-unit-crud";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const UNIT_ID = "unit-1";
const PARENT_ID = "parent-1";

const branchRow = {
  id: UNIT_ID,
  orgId: ORG_ID,
  name: "North",
  code: "NORTH",
  description: null,
  status: "ACTIVE",
  parentId: PARENT_ID,
  metadata: {},
  headUserId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

const businessUnitRow = {
  ...branchRow,
  headUserId: undefined,
};

function selectChain(rows: unknown[]) {
  const builder = {
    from: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  builder.from.mockReturnValue(builder);
  builder.leftJoin.mockReturnValue(builder);
  builder.where.mockReturnValue(builder);
  return builder;
}

function makeHarness(
  selectedRows: unknown[][],
  cacheFailure?: Error,
) {
  const select = jest.fn().mockImplementation(() =>
    selectChain(selectedRows.shift() ?? []),
  );
  const insertValues = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([branchRow]),
  });
  const updateReturning = jest.fn().mockResolvedValue([branchRow]);
  const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const cache = {
    invalidateAfterMutation: cacheFailure
      ? jest.fn().mockRejectedValue(cacheFailure)
      : jest.fn().mockResolvedValue(undefined),
  };
  const db = {
    select,
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    update: jest.fn().mockReturnValue({ set: updateSet }),
    query: {
      orgUnits: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
  } as unknown as Db;
  const crud = new OrgUnitCrudService(db, audit, cache);
  return {
    branches: new OrgHierarchyBranchesService(crud),
    businessUnits: new OrgHierarchyBusinessUnitsService(crud),
    audit,
    cache,
    db,
  };
}

async function expectParentUnavailable(mutation: Promise<unknown>) {
  let caught: unknown;
  try {
    await mutation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BadRequestException);
  if (!(caught instanceof BadRequestException)) throw caught;
  expect(caught.getResponse()).toEqual({
    code: "ORG_UNIT_PARENT_UNAVAILABLE",
    message:
      "Select an active business unit. Archived, disabled, or removed units cannot receive new assignments.",
  });
}

describe("OrgUnitCrudService lifecycle", () => {
  it("rejects create when an optional parent is unavailable", async () => {
    const harness = makeHarness([[]]);

    await expectParentUnavailable(
      harness.branches.createOrgBranch(ORG_ID, USER_ID, {
        name: "North",
        code: "NORTH",
        businessUnitId: PARENT_ID,
      }),
    );

    expect(harness.db.insert).not.toHaveBeenCalled();
    expect(harness.audit.logCritical).not.toHaveBeenCalled();
    expect(harness.cache.invalidateAfterMutation).not.toHaveBeenCalled();
  });

  it("rejects update when its requested parent is unavailable", async () => {
    const harness = makeHarness([[branchRow], []]);

    await expectParentUnavailable(
      harness.branches.updateOrgBranch(ORG_ID, USER_ID, UNIT_ID, {
        businessUnitId: "parent-2",
      }),
    );

    expect(harness.db.update).not.toHaveBeenCalled();
    expect(harness.audit.logCritical).not.toHaveBeenCalled();
    expect(harness.cache.invalidateAfterMutation).not.toHaveBeenCalled();
  });

  it("validates a legacy business unit parent when restoring ACTIVE", async () => {
    const harness = makeHarness([[businessUnitRow], []]);

    await expectParentUnavailable(
      harness.businessUnits.updateBusinessUnit(ORG_ID, USER_ID, UNIT_ID, {
        status: "ACTIVE",
      }),
    );

    expect(harness.db.update).not.toHaveBeenCalled();
    expect(harness.cache.invalidateAfterMutation).not.toHaveBeenCalled();
  });

  it("invalidates after each successful create and update", async () => {
    const harness = makeHarness([[branchRow]]);

    await harness.branches.createOrgBranch(ORG_ID, USER_ID, {
      name: "North",
      code: "NORTH",
    });
    await harness.branches.updateOrgBranch(ORG_ID, USER_ID, UNIT_ID, {
      name: "North East",
    });

    expect(harness.audit.logCritical).toHaveBeenCalledTimes(2);
    expect(harness.cache.invalidateAfterMutation).toHaveBeenCalledTimes(2);
    expect(harness.cache.invalidateAfterMutation).toHaveBeenNthCalledWith(
      1,
      ORG_ID,
    );
    expect(harness.cache.invalidateAfterMutation).toHaveBeenNthCalledWith(
      2,
      ORG_ID,
    );
  });

  it("propagates cache invalidation failure after a successful write", async () => {
    const failure = new Error("cache unavailable");
    const harness = makeHarness([], failure);

    await expect(
      harness.branches.createOrgBranch(ORG_ID, USER_ID, {
        name: "North",
        code: "NORTH",
      }),
    ).rejects.toBe(failure);

    expect(harness.db.insert).toHaveBeenCalledTimes(1);
    expect(harness.audit.logCritical).toHaveBeenCalledTimes(1);
    expect(harness.cache.invalidateAfterMutation).toHaveBeenCalledWith(ORG_ID);
  });
});
