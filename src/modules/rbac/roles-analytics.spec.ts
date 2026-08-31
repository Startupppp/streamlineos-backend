import { auditLogs, roleAssignments, roles } from "../../db/schema";
import { RolesQueryService } from "./roles-query.service";

describe("RolesQueryService.getRoleAnalytics", () => {
  it("uses unbounded aggregates and counts distinct assigned memberships", async () => {
    const roleWhere = jest.fn().mockResolvedValue([
      {
        totalRoles: 205,
        systemRoles: 5,
        customRoles: 200,
      },
    ]);
    const assignmentWhere = jest.fn().mockResolvedValue([{ value: 73 }]);
    const changesWhere = jest.fn().mockResolvedValue([{ value: 9 }]);
    const from = jest.fn((table: unknown) => {
      if (table === roles) return { where: roleWhere };
      if (table === roleAssignments) return { where: assignmentWhere };
      if (table === auditLogs) return { where: changesWhere };
      throw new Error("Unexpected analytics table");
    });
    const select = jest.fn().mockReturnValue({ from });
    const service: RolesQueryService = Object.create(RolesQueryService.prototype);
    Reflect.set(service, "db", { select });

    await expect(service.getRoleAnalytics("org-1")).resolves.toEqual({
      totalRoles: 205,
      customRoles: 200,
      systemRoles: 5,
      totalPermissions: expect.any(Number),
      usersAssigned: 73,
      recentChanges: 9,
    });
    expect(select).toHaveBeenCalledTimes(3);
    expect(from).toHaveBeenCalledWith(roles);
    expect(from).toHaveBeenCalledWith(roleAssignments);
    expect(from).toHaveBeenCalledWith(auditLogs);
  });

  it("returns zeroes when aggregate rows are unavailable", async () => {
    const select = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    });
    const service: RolesQueryService = Object.create(RolesQueryService.prototype);
    Reflect.set(service, "db", { select });

    await expect(service.getRoleAnalytics("org-1")).resolves.toEqual({
      totalRoles: 0,
      customRoles: 0,
      systemRoles: 0,
      totalPermissions: expect.any(Number),
      usersAssigned: 0,
      recentChanges: 0,
    });
  });
});
