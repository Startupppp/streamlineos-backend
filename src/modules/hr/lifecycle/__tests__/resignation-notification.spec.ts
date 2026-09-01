process.env.APP_URL ??= "http://localhost:1000";

import { ResignationJobsService } from "../resignation-jobs.service";

function buildNotificationsService() {
  const sent: { orgId: string; userId: string; type: string; title: string }[] = [];
  return {
    create: jest.fn().mockImplementation(
      (n: { orgId: string; userId: string; type: string; title: string }) => {
        sent.push(n);
        return Promise.resolve();
      },
    ),
    _sent: sent,
  };
}

function buildDb(employeeName: string, orgOwnerIds: string[]) {
  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(
            orgOwnerIds.map((userId) => ({ userId })),
          ),
        }),
      })),
    })),
    query: {
      users: {
        findFirst: jest.fn().mockResolvedValue({ name: employeeName }),
      },
    },
  };
}

function buildAccessService(userIds: string[]) {
  return {
    membersWithPermission: jest.fn().mockResolvedValue(
      userIds.map((userId) => ({ userId, membershipId: 1 })),
    ),
  };
}

describe("ResignationJobsService — permission-based routing", () => {
  it("notifyResignationSubmitted fans out to hr:exit:manage holders and excludes the employee", async () => {
    const hrUserId = "hr-user-1";
    const employeeId = "employee-1";
    const orgId = "org-1";

    const notifications = buildNotificationsService();
    const db = buildDb("Alice", []);
    const access = buildAccessService([hrUserId, employeeId]);

    const service = new ResignationJobsService(
      db as never,
      notifications as never,
      { log: jest.fn() } as never,
      access as never,
    );

    service.notifyResignationSubmitted(orgId, employeeId);

    await new Promise((r) => setTimeout(r, 50));

    expect(access.membersWithPermission).toHaveBeenCalledWith(orgId, "hr:exit:manage");

    const recipients = notifications._sent.map((n) => n.userId);
    expect(recipients).toContain(hrUserId);
    expect(recipients).not.toContain(employeeId);
  });

  it("excludes users with no hr:exit:manage grant from exit notifications", async () => {
    const orgId = "org-1";
    const employeeId = "employee-2";
    const notifications = buildNotificationsService();
    const db = buildDb("Bob", []);
    const access = buildAccessService([]);

    const service = new ResignationJobsService(
      db as never,
      notifications as never,
      { log: jest.fn() } as never,
      access as never,
    );

    service.notifyResignationSubmitted(orgId, employeeId);
    await new Promise((r) => setTimeout(r, 50));

    expect(notifications._sent).toHaveLength(0);
  });

  it("notifyHrApproved fans out to org admins (isOwner=true)", async () => {
    const orgId = "org-1";
    const employeeId = "employee-3";
    const ownerId = "org-owner-1";

    const notifications = buildNotificationsService();
    const db = buildDb("Carol", [ownerId]);
    const access = buildAccessService([]);

    const service = new ResignationJobsService(
      db as never,
      notifications as never,
      { log: jest.fn() } as never,
      access as never,
    );

    service.notifyHrApproved(orgId, employeeId);
    await new Promise((r) => setTimeout(r, 50));

    const recipients = notifications._sent.map((n) => n.userId);
    expect(recipients).toContain(ownerId);
  });
});
