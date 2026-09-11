import { rolePermissionGrants, roles } from "../../db/schema";
import {
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSIONS,
} from "./permissions";
import { RolesService } from "./roles.service";

describe("RolesService.getRoles", () => {
  it("returns a bounded page with permission counts and no-more-pages signal", async () => {
    const role = {
      id: 12,
      name: "Manager",
      slug: "MANAGER",
      orgId: "org-1",
      isSystem: false,
      moduleKey: null,
      rank: 40,
      description: "Manages a team",
      version: 1,
      createdBy: "user-1",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      explicitPermissionCount: 7,
      universalGrantCount: 2,
      memberCount: 5,
      cursorSortValue: "manager",
    };
    const limit = jest.fn().mockResolvedValue([role]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const groupBy = jest.fn().mockReturnValue({ orderBy });
    const pageWhere = jest.fn().mockReturnValue({ groupBy });
    const leftJoin = jest.fn().mockReturnValue({ where: pageWhere });
    const pageFrom = jest.fn().mockReturnValue({ leftJoin });
    const select = jest.fn().mockReturnValue({ from: pageFrom });
    const service: RolesService = Object.create(RolesService.prototype);
    Reflect.set(service, "db", { select });

    await expect(
      service.getRoles("org-1", {
        cursor: undefined,
        limit: 20,
        search: "manager",
      }),
    ).resolves.toEqual({
      data: [
        {
          id: role.id,
          name: role.name,
          slug: role.slug,
          orgId: role.orgId,
          isSystem: role.isSystem,
          moduleKey: role.moduleKey,
          rank: role.rank,
          description: role.description,
          version: role.version,
          createdBy: role.createdBy,
          createdAt: role.createdAt,
          updatedAt: role.updatedAt,
          permissionCount: UNIVERSAL_MEMBER_PERMISSIONS.length + 5,
          memberCount: 5,
        },
      ],
      pagination: {
        limit: 20,
        nextCursor: null,
        hasMore: false,
      },
    });
    expect(leftJoin).toHaveBeenCalledWith(rolePermissionGrants, expect.anything());
    expect(groupBy).toHaveBeenCalledWith(roles.id);
    expect(orderBy).toHaveBeenCalledTimes(1);
    expect(orderBy.mock.calls[0]).toHaveLength(2);
    expect(limit).toHaveBeenCalledWith(21);
  });

  it("returns an empty page when no roles match", async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const groupBy = jest.fn().mockReturnValue({ orderBy });
    const where = jest.fn().mockReturnValue({ groupBy });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    const select = jest.fn().mockReturnValue({ from });
    const service: RolesService = Object.create(RolesService.prototype);
    Reflect.set(service, "db", { select });

    await expect(
      service.getRoles("org-1", { limit: 10 }),
    ).resolves.toEqual({
      data: [],
      pagination: {
        limit: 10,
        nextCursor: null,
        hasMore: false,
      },
    });
  });

  it("uses effective default permissions when a legacy role has no grant rows", async () => {
    const role = {
      id: 2,
      name: "Member",
      slug: "MEMBER",
      orgId: "org-1",
      isSystem: true,
      moduleKey: null,
      rank: 40,
      description: null,
      version: 1,
      createdBy: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      explicitPermissionCount: 0,
      universalGrantCount: 0,
      memberCount: 3,
      cursorSortValue: "member",
    };
    const limit = jest.fn().mockResolvedValue([role]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const groupBy = jest.fn().mockReturnValue({ orderBy });
    const where = jest.fn().mockReturnValue({ groupBy });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    const select = jest.fn().mockReturnValue({ from });
    const service: RolesService = Object.create(RolesService.prototype);
    Reflect.set(service, "db", { select });
    const expectedPermissionCount = new Set([
      ...UNIVERSAL_MEMBER_PERMISSIONS,
      ...(ROLE_DEFAULT_PERMISSIONS.MEMBER ?? []),
    ]).size;

    const result = await service.getRoles("org-1", { limit: 10 });

    expect(result.data).toEqual([
      expect.objectContaining({
        id: role.id,
        permissionCount: expectedPermissionCount,
      }),
    ]);
    expect(result.data[0]).not.toHaveProperty("explicitPermissionCount");
    expect(result.data[0]).not.toHaveProperty("universalGrantCount");
    expect(result.data[0]).not.toHaveProperty("cursorSortValue");
  });
});
