jest.mock("../../common/rbac/sync-structural-role", () => ({
  syncStructuralRoleAssignments: jest.fn().mockResolvedValue(undefined),
}));

import { getTableColumns } from "drizzle-orm";
import { auditLogs, users, hrEmployments } from "../../db/schema";
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
  const onConflictDoUpdate = jest.fn().mockResolvedValue([]);
  const inserted: Array<{ table: unknown; row: unknown }> = [];
  const txInsert = jest.fn().mockImplementation((table: unknown) => ({
    values: jest.fn().mockImplementation((row: unknown) => {
      inserted.push({ table, row });
      return Object.assign(Promise.resolve([]), { onConflictDoNothing, onConflictDoUpdate });
    }),
  }));

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

  const auditLog = jest.fn();
  const cache = {
    invalidate: jest.fn(),
    invalidateForOrg: jest.fn(),
    invalidateNamespace: jest.fn(),
    invalidateMany: jest.fn(),
    invalidateNamespaceMany: jest.fn(),
  };
  const service = new UserOpsService(
    db as never,
    { log: auditLog } as never,
    cache as never,
    {} as never,
    {} as never,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) } as never,
    {} as never,
    { getFacts: jest.fn(), getFactsBatch: jest.fn() } as never,
  );

  return { db, tx, service, updatedTables, setCalls, inserted, auditLog, cache };
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
      expect.objectContaining({
        audit: expect.objectContaining({ action: "user.bulk_updated", userId: "actor-1" }),
        revoke: expect.objectContaining({
          loses: [{ kind: "standing", userIds: ["user-a", "user-b"] }],
        }),
      }),
    );
  });

  it("commits a bulk role change's audit and every target's session bust inside the role change, not best-effort after it", async () => {
    const { service, auditLog } = buildService(
      [{ userId: "user-a" }, { userId: "user-b" }],
      [{ id: 11 }, { id: 12 }],
    );

    await service.bulkUpdateUsers("org-a", { userIds: ["user-a", "user-b"], role: "MEMBER" }, ownerActor);

    expect(auditLog).not.toHaveBeenCalled();
    expect(syncStructuralRoleAssignments).toHaveBeenCalledWith(
      expect.anything(),
      "org-a",
      [11, 12],
      "MEMBER",
      expect.objectContaining({ revoke: expect.anything() }),
    );
  });

  it("writes the audit row on the transaction and busts the targets' sessions when only placement changes", async () => {
    const { service, inserted, auditLog, cache } = buildService([{ userId: "user-a" }]);

    await service.bulkUpdateUsers("org-a", { userIds: ["user-a"], departmentId: "dept-1" }, actor);

    const audits = inserted.filter((entry) => entry.table === auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.row).toMatchObject({ action: "user.bulk_updated", orgId: "org-a" });
    expect(auditLog).not.toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledWith("user:session:user-a");
    expect(syncStructuralRoleAssignments).not.toHaveBeenCalled();
  });
});
