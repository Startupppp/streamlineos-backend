import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AccessService } from "../access/access.service";
import { RoleMemberService } from "./role-member.service";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn().mockImplementation(
    (_db: unknown, fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        delete: jest.fn().mockReturnValue({ where: jest.fn() }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn() }),
        }),
      };
      return fn(tx);
    },
  ),
}));

/**
 * Structural lockout guard belongs at OrgMembershipService.updateMemberRole
 * (src/modules/organization/core/org-membership.service.ts), not here.
 *
 * Deleting an RBAC role or removing someone from an RBAC role cannot change
 * organizationMembers.role. Structural admin status (isOwner or role=ORG_ADMIN)
 * is orthogonal to RBAC role assignments, so no lockout check belongs in either
 * operation — and the RoleLockoutService has been deleted accordingly.
 *
 * These tests pin that removeRoleMember has no lockout barrier: with no
 * RoleLockoutService in the DI container, the method still reaches the
 * transaction for both user and group principals.
 */
describe("removeRoleMember — no lockout barrier after structural authority change", () => {
  const roleFindFirst = jest.fn();
  const memberFindFirst = jest.fn();
  const select = jest.fn();
  const cacheInvalidate = jest.fn();

  let service: RoleMemberService;

  const actor = {
    userId: "admin-user",
    orgId: "org-1",
    role: "ORG_ADMIN" as const,
    permissions: [] as string[],
    isOrgOwner: false,
    tokenScopes: null,
    sessionId: "sess-abc",
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    roleFindFirst.mockResolvedValue({
      id: 10,
      orgId: "org-1",
      name: "Engineer",
      slug: "ENGINEER",
      isSystem: false,
      moduleKey: null,
      rank: 40,
    });

    memberFindFirst.mockResolvedValue({ id: 99 });

    select.mockReturnValue({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        RoleMemberService,
        {
          provide: DRIZZLE,
          useValue: {
            query: {
              roles: { findFirst: roleFindFirst },
              organizationMembers: { findFirst: memberFindFirst },
            },
            select,
          },
        },
        { provide: CacheService, useValue: { invalidate: cacheInvalidate } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: AccessService,
          useValue: {
            resolveUserPermissions: jest.fn(),
            getPermissionsVersion: jest.fn(),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(RoleMemberService);
  });

  it("proceeds for a user principal — no ForbiddenException from a missing lockout service", async () => {
    const result = await service.removeRoleMember(actor, 10, {
      principalType: "user",
      principalId: "member-user",
    });
    expect(result).toEqual({ success: true });
  });

  it("proceeds for a group principal — no ForbiddenException from a missing lockout service", async () => {
    const result = await service.removeRoleMember(actor, 10, {
      principalType: "group",
      principalId: "group-uuid",
    });
    expect(result).toEqual({ success: true });
  });

  it("throws NotFoundException before any transaction when role is not found", async () => {
    roleFindFirst.mockResolvedValue(undefined);

    await expect(
      service.removeRoleMember(actor, 10, {
        principalType: "user",
        principalId: "member-user",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
