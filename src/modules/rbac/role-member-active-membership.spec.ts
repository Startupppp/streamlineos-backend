import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AccessService } from "../access/access.service";
import { RoleLockoutService } from "./role-lockout.service";
import { RoleMemberService } from "./role-member.service";

describe("RoleMemberService active membership enforcement", () => {
  const roleFindFirst = jest.fn();
  const memberFindFirst = jest.fn();
  const transaction = jest.fn();
  let service: RoleMemberService;

  beforeEach(async () => {
    jest.clearAllMocks();
    roleFindFirst.mockResolvedValue({
      id: 7,
      orgId: "org-a",
      name: "Manager",
      slug: "MANAGER",
      isSystem: false,
      moduleKey: null,
      rank: 40,
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
            transaction,
          },
        },
        { provide: CacheService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationDispatchService, useValue: {} },
        { provide: RoleLockoutService, useValue: {} },
        { provide: AccessService, useValue: { resolveUserPermissions: jest.fn(), getPermissionsVersion: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(RoleMemberService);
  });

  it.each(["SUSPENDED", "LEFT"] as const)(
    "rejects assigning a role to a %s member",
    async (status) => {
      memberFindFirst.mockResolvedValue({ id: 42, status });

      await expect(
        service.addRoleMember(
          {
            userId: "admin",
            orgId: "org-a",
            role: "ORG_ADMIN",
            permissions: [],
            isOrgOwner: true,
            tokenScopes: null,
            sessionId: "session",
          },
          7,
          { principalType: "user", principalId: "member" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
