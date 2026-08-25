import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { ROLE_RANK } from "../../common/rbac/grantability";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AccessService } from "../access/access.service";
import { RoleMemberService } from "./role-member.service";

describe("assertMayAssignRole — MODULE_OWNER rank is blocked on the generic path", () => {
  const roleFindFirst = jest.fn();
  let service: RoleMemberService;

  beforeEach(async () => {
    jest.clearAllMocks();
    roleFindFirst.mockResolvedValue({
      id: 42,
      orgId: "org-test",
      slug: "HR_MODULE_OWNER",
      name: "HR Module Owner",
      isSystem: true,
      moduleKey: "hr",
      rank: ROLE_RANK.MODULE_OWNER,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        RoleMemberService,
        {
          provide: DRIZZLE,
          useValue: {
            query: {
              roles: { findFirst: roleFindFirst },
              organizationMembers: { findFirst: jest.fn() },
            },
            select: jest.fn(),
          },
        },
        { provide: CacheService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationDispatchService, useValue: {} },
        {
          provide: AccessService,
          useValue: { resolveUserPermissions: jest.fn(), getPermissionsVersion: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(RoleMemberService);
  });

  it.each([true, false] as const)(
    "rejects MODULE_OWNER role assignment on the generic path (isOrgOwner=%s)",
    async (isOrgOwner) => {
      await expect(
        service.addRoleMember(
          {
            userId: "admin-1",
            orgId: "org-test",
            role: isOrgOwner ? "OWNER" : "ORG_ADMIN",
            isOrgOwner,
            tokenScopes: null,
            sessionId: "sess-1",
          },
          42,
          { principalType: "user", principalId: "other-member" },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it("does not call the database for permission resolution when MODULE_OWNER rank is rejected early", async () => {
    const dbMock = {
      query: {
        roles: { findFirst: roleFindFirst },
        organizationMembers: { findFirst: jest.fn() },
      },
      select: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        RoleMemberService,
        { provide: DRIZZLE, useValue: dbMock },
        { provide: CacheService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationDispatchService, useValue: {} },
        {
          provide: AccessService,
          useValue: { resolveUserPermissions: jest.fn(), getPermissionsVersion: jest.fn() },
        },
      ],
    }).compile();
    const svc = moduleRef.get(RoleMemberService);

    await expect(
      svc.addRoleMember(
        {
          userId: "admin-1",
          orgId: "org-test",
          role: "OWNER",
          isOrgOwner: true,
          tokenScopes: null,
          sessionId: "sess-1",
        },
        42,
        { principalType: "user", principalId: "other-member" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(dbMock.select).not.toHaveBeenCalled();
  });
});
