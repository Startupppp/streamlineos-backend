jest.mock("../../common/hr/sync-canonical-reporting-line", () => ({
  syncCanonicalReportingLine: jest.fn().mockResolvedValue({ status: "written" }),
}));

import { getTableColumns } from "drizzle-orm";
import { users, hrEmployments } from "../../db/schema";
import { syncCanonicalReportingLine } from "../../common/hr/sync-canonical-reporting-line";
import { UserOpsService } from "./user-ops.service";

function buildService(scopedMembers: Array<{ userId: string }> = [{ userId: "user-a" }]) {
  const updatedTables: unknown[] = [];
  const setCalls: unknown[] = [];

  const updateWhere = jest.fn().mockResolvedValue([]);
  const updateSet = jest.fn().mockImplementation((data: unknown) => {
    setCalls.push(data);
    return { where: updateWhere };
  });
  const txUpdate = jest.fn().mockImplementation((table: unknown) => {
    updatedTables.push(table);
    return { set: updateSet };
  });

  const deleteWhere = jest.fn().mockResolvedValue([]);
  const txDelete = jest.fn().mockReturnValue({ where: deleteWhere });

  const onConflictDoNothing = jest.fn().mockResolvedValue([]);
  const insertValues = jest.fn().mockReturnValue({ onConflictDoNothing });
  const txInsert = jest.fn().mockReturnValue({ values: insertValues });

  const selectInnerJoinWhere = jest.fn().mockResolvedValue([]);
  const selectInnerJoin = jest.fn().mockReturnValue({ where: selectInnerJoinWhere });
  const selectWhere = jest.fn().mockResolvedValue(scopedMembers);
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere, innerJoin: selectInnerJoin });
  const txSelect = jest.fn().mockReturnValue({ from: selectFrom });

  const tx = {
    query: {
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ userId: "manager-1" }),
      },
    },
    update: txUpdate,
    delete: txDelete,
    insert: txInsert,
    select: txSelect,
  };

  const db = {
    transaction: jest.fn((callback) => callback(tx)),
  };

  const service = new UserOpsService(
    db as never,
    { log: jest.fn() } as never,
    { invalidate: jest.fn(), invalidateForOrg: jest.fn() } as never,
    {} as never,
    {} as never,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) } as never,
    {} as never,
    { getFacts: jest.fn(), getFactsBatch: jest.fn() } as never,
  );

  return { db, tx, service, updatedTables, setCalls };
}

const actor = { userId: "actor-1", isOrgOwner: false };

describe("bulkUpdateUsers — removed-column regression", () => {
  it("users table has no orgDepartmentId, branchId, or reportingTo columns", () => {
    const cols = Object.keys(getTableColumns(users));
    expect(cols).not.toContain("orgDepartmentId");
    expect(cols).not.toContain("branchId");
    expect(cols).not.toContain("reportingTo");
  });
});

describe("bulkUpdateUsers — no users table write", () => {
  it("does not write to the global users table when department, branch, and manager are all supplied", async () => {
    const { service, updatedTables } = buildService([{ userId: "user-a" }]);

    await service.bulkUpdateUsers("org-a", {
      userIds: ["user-a"],
      departmentId: "dept-1",
      branchId: "branch-1",
      managerUserId: "manager-1",
    }, actor);

    expect(updatedTables).not.toContain(users);
  });
});

describe("bulkUpdateUsers — cross-org isolation", () => {
  it("only processes members belonging to the target org and returns their count", async () => {
    jest.mocked(syncCanonicalReportingLine).mockClear();
    const { service } = buildService([{ userId: "user-a" }]);

    const result = await service.bulkUpdateUsers("org-a", {
      userIds: ["user-a", "user-b"],
      managerUserId: "manager-1",
    }, actor);

    expect(result.updated).toBe(1);
    expect(syncCanonicalReportingLine).toHaveBeenCalledTimes(1);
    expect(syncCanonicalReportingLine).toHaveBeenCalledWith(
      expect.anything(),
      "org-a",
      "user-a",
      "manager-1",
      expect.any(String),
      "actor-1",
    );
  });
});

describe("bulkUpdateUsers — canonical destination writes", () => {
  beforeEach(() => {
    jest.mocked(syncCanonicalReportingLine).mockClear();
  });

  it("writes departmentId to hrEmployments", async () => {
    const { service, updatedTables, setCalls } = buildService([{ userId: "user-a" }]);

    await service.bulkUpdateUsers("org-a", {
      userIds: ["user-a"],
      departmentId: "dept-1",
    }, actor);

    expect(updatedTables).toContain(hrEmployments);
    expect(setCalls).toContainEqual(expect.objectContaining({ departmentId: "dept-1" }));
  });

  it("writes locationId to hrEmployments for branch", async () => {
    const { service, updatedTables, setCalls } = buildService([{ userId: "user-a" }]);

    await service.bulkUpdateUsers("org-a", {
      userIds: ["user-a"],
      branchId: "branch-1",
    }, actor);

    expect(updatedTables).toContain(hrEmployments);
    expect(setCalls).toContainEqual(expect.objectContaining({ locationId: "branch-1" }));
  });

  it("calls syncCanonicalReportingLine once per user for manager update", async () => {
    const { service } = buildService([{ userId: "user-a" }]);

    await service.bulkUpdateUsers("org-a", {
      userIds: ["user-a"],
      managerUserId: "manager-1",
    }, actor);

    expect(syncCanonicalReportingLine).toHaveBeenCalledTimes(1);
    expect(syncCanonicalReportingLine).toHaveBeenCalledWith(
      expect.anything(),
      "org-a",
      "user-a",
      "manager-1",
      expect.any(String),
      "actor-1",
    );
  });
});
