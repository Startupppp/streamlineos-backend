jest.mock("../../common/rbac/sync-structural-role", () => ({
  syncStructuralRoleAssignments: jest.fn().mockResolvedValue(undefined),
}));

import { getTableColumns } from "drizzle-orm";
import { users, hrEmployments } from "../../db/schema";
import { syncStructuralRoleAssignments } from "../../common/rbac/sync-structural-role";
import { UserOpsService } from "./user-ops.service";

function buildService(
  scopedMembers: Array<{ userId: string }> = [{ userId: "user-a" }],
  membershipRows: Array<{ id: number }> = [],
) {
  const updatedTables: unknown[] = [];
  const setCalls: unknown[] = [];

  const returning = jest.fn().mockResolvedValue(membershipRows);
  const updateWhere = jest
    .fn()
    .mockImplementation(() => Object.assign(Promise.resolve([]), { returning }));
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
  const selectWhere = jest
    .fn()
    .mockImplementation(() =>
      Object.assign(Promise.resolve(scopedMembers), {
        limit: jest.fn().mockResolvedValue([]),
      }),
    );
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

  const organizationTimezone = {
    from: () => ({ where: () => ({ limit: () => Promise.resolve([{ timezone: "UTC" }]) }) }),
  };
  const db = {
    transaction: jest.fn((callback: (handle: typeof tx) => unknown) => callback(tx)),
    select: jest.fn(() => organizationTimezone),
  };

  const service = new UserOpsService(
    db as never,
    { log: jest.fn() } as never,
    {
      invalidate: jest.fn(),
      invalidateForOrg: jest.fn(),
      invalidateNamespace: jest.fn(),
      invalidateMany: jest.fn(),
      invalidateNamespaceMany: jest.fn(),
    } as never,
    {} as never,
    {} as never,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) } as never,
    {} as never,
    { getFacts: jest.fn(), getFactsBatch: jest.fn() } as never,
  );

  return { db, tx, service, updatedTables, setCalls };
}

const actor = { userId: "actor-1", isOrgOwner: false };
const ownerActor = { userId: "actor-1", isOrgOwner: true };

beforeEach(() => {
  jest.mocked(syncStructuralRoleAssignments).mockClear();
});

describe("bulkUpdateUsers — removed-column regression", () => {
  it("users table has no orgDepartmentId, branchId, or reportingTo columns", () => {
    const cols = Object.keys(getTableColumns(users));
    expect(cols).not.toContain("orgDepartmentId");
    expect(cols).not.toContain("branchId");
    expect(cols).not.toContain("reportingTo");
  });
});

describe("bulkUpdateUsers — no users table write", () => {
  it("does not write to the global users table when department and branch are both supplied", async () => {
    const { service, updatedTables } = buildService([{ userId: "user-a" }]);

    await service.bulkUpdateUsers("org-a", {
      userIds: ["user-a"],
      departmentId: "dept-1",
      branchId: "branch-1",
    }, actor);

    expect(updatedTables).not.toContain(users);
  });
});

describe("bulkUpdateUsers — cross-org isolation", () => {
  it("only processes members belonging to the target org and returns their count", async () => {
    const { service } = buildService([{ userId: "user-a" }]);

    const result = await service.bulkUpdateUsers("org-a", {
      userIds: ["user-a", "user-b"],
      departmentId: "dept-1",
    }, actor);

    expect(result.updated).toBe(1);
  });
});

describe("bulkUpdateUsers — canonical destination writes", () => {
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

  it("syncs the structural role for every updated membership in one batched call", async () => {
    const { service } = buildService(
      [{ userId: "user-a" }, { userId: "user-b" }],
      [{ id: 11 }, { id: 12 }],
    );

    await service.bulkUpdateUsers("org-a", {
      userIds: ["user-a", "user-b"],
      role: "MEMBER",
    }, ownerActor);

    expect(syncStructuralRoleAssignments).toHaveBeenCalledTimes(1);
    expect(syncStructuralRoleAssignments).toHaveBeenCalledWith(
      expect.anything(),
      "org-a",
      [11, 12],
      "MEMBER",
    );
  });
});
