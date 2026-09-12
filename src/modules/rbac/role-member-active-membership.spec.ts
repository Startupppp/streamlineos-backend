import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AccessService } from "../access/access.service";
import { RoleMemberService } from "./role-member.service";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

jest.mock("../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

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
            isOrgOwner: true,
            tokenScopes: null,
            sessionId: "session",
            principal: humanSessionPrincipal(1, true),
          },
          7,
          { principalType: "user", principalId: "member" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(transaction).not.toHaveBeenCalled();
    },
  );
});

describe("RoleMemberService — the version bump shares the writer's transaction", () => {
  const ORG = "org-a";
  const ROLE_ID = 7;

  function makeTx() {
    return {
      execute: jest.fn().mockResolvedValue([{}]),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    };
  }

  function makeAssigneeRead() {
    const chain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue([]),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    return chain;
  }

  async function buildService(tx: ReturnType<typeof makeTx>) {
    const transaction = jest.fn().mockImplementation(
      async (fn: (handle: typeof tx) => Promise<unknown>) => fn(tx),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        RoleMemberService,
        {
          provide: DRIZZLE,
          useValue: {
            query: {
              roles: {
                findFirst: jest.fn().mockResolvedValue({
                  id: ROLE_ID,
                  orgId: ORG,
                  name: "Manager",
                  slug: "MANAGER",
                  isSystem: false,
                  moduleKey: null,
                  rank: 40,
                }),
              },
              organizationMembers: {
                findFirst: jest.fn().mockResolvedValue({ id: 42, status: "ACTIVE" }),
              },
            },
            select: jest.fn().mockImplementation(makeAssigneeRead),
            transaction,
          },
        },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateMany: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: NotificationDispatchService,
          useValue: { emit: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: AccessService,
          useValue: { resolveUserPermissions: jest.fn(), getPermissionsVersion: jest.fn() },
        },
      ],
    }).compile();
    return { service: moduleRef.get(RoleMemberService), transaction };
  }

  const orgOwner: CurrentUserContext = {
    userId: "admin",
    orgId: ORG,
    role: "ORG_ADMIN",
    isOrgOwner: true,
    tokenScopes: null,
    sessionId: "session",
    principal: humanSessionPrincipal(1, true),
  };

  beforeEach(() => {
    jest.mocked(bumpPermissionsVersion).mockClear();
    jest.mocked(bumpPermissionsVersion).mockResolvedValue(undefined);
  });

  it("addRoleMember bumps the version on the same handle the assignment was inserted on", async () => {
    const tx = makeTx();
    const { service, transaction } = await buildService(tx);

    await service.addRoleMember(orgOwner, ROLE_ID, {
      principalType: "user",
      principalId: "member",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(bumpPermissionsVersion).toHaveBeenCalledWith(tx, ORG);
  });

  it("removeRoleMember bumps the version on the same handle the assignment was deleted on", async () => {
    const tx = makeTx();
    const { service, transaction } = await buildService(tx);

    await service.removeRoleMember(orgOwner, ROLE_ID, {
      principalType: "user",
      principalId: "member",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.delete).toHaveBeenCalledTimes(1);
    expect(bumpPermissionsVersion).toHaveBeenCalledWith(tx, ORG);
  });
});
