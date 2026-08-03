process.env.APP_URL ??= "http://localhost:1000";

import { LeadsOpsService } from "../leads-ops.service";

function buildSelectWhere(directResult: unknown[], limitResult: unknown[]) {
  return Object.assign(Promise.resolve(directResult), {
    limit: jest.fn().mockResolvedValue(limitResult),
  });
}

function buildDb(orgHasMember: boolean, assignableUserIds: string[]) {
  const userRows = assignableUserIds.map((id) => ({
    id,
    name: "Agent",
    email: `${id}@test.com`,
  }));
  const memberRows = orgHasMember ? [{ userId: "member-1" }] : [];

  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() =>
          buildSelectWhere(userRows, memberRows),
        ),
      })),
    })),
    query: {
      users: {
        findMany: jest.fn().mockResolvedValue(userRows),
      },
      leads: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      leaveRequests: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
  };
}

function buildAccessService(userIds: string[]) {
  return {
    membersWithPermission: jest.fn().mockResolvedValue(
      userIds.map((userId) => ({ userId, membershipId: 1 })),
    ),
  };
}

describe("LeadsOpsService — crm:leads:assign permission routing", () => {
  it("distribute returns no_sales when no users hold crm:leads:assign", async () => {
    const db = buildDb(true, []);
    const access = buildAccessService([]);

    const service = new LeadsOpsService(
      db as never,
      { log: jest.fn() } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      access as never,
    );

    const result = await service.distribute("org-1", "user-1", { leadIds: [1, 2], skipAbsent: false });

    expect(access.membersWithPermission).toHaveBeenCalledWith("org-1", "crm:leads:assign", {
      limit: 500,
    });
    expect(result).toEqual({ ok: false, reason: "no_sales" });
  });

  it("distribute uses holders of crm:leads:assign as eligible agents", async () => {
    const salesUserId = "sales-agent-1";
    const db = buildDb(true, [salesUserId]);
    const access = buildAccessService([salesUserId]);

    const service = new LeadsOpsService(
      db as never,
      { log: jest.fn() } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      access as never,
    );

    await service.distribute("org-1", "user-1", { leadIds: [1], skipAbsent: false });

    expect(access.membersWithPermission).toHaveBeenCalledWith("org-1", "crm:leads:assign", {
      limit: 500,
    });
  });

  it("a user without crm:leads:assign grant is not included in distribution", async () => {
    const grantedUser = "sales-agent-granted";
    const ungrantedUser = "sales-agent-ungrant";
    const db = buildDb(true, [grantedUser]);
    const access = buildAccessService([grantedUser]);

    const service = new LeadsOpsService(
      db as never,
      { log: jest.fn() } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      access as never,
    );

    await service.distribute("org-1", "user-1", { leadIds: [], skipAbsent: false });

    const call = access.membersWithPermission.mock.calls[0];
    expect(call[1]).toBe("crm:leads:assign");

    await expect(access.membersWithPermission()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: ungrantedUser })]),
    );
  });
});
