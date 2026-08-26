import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { AccessService } from "../../access/access.service";
import { Test } from "@nestjs/testing";
import { EmailService } from "../../email/email.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { OrgMembershipService } from "./org-membership.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { SessionsService } from "../../sessions/sessions.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AblyService } from "../../realtime/ably.service";
import { orgUnitMembers, users } from "../../../db/schema";
import {
  runWithTenantContext,
  type AfterCommitHook,
} from "../../../common/tenant/tenant-context";

const ORG_ID = "org-1";
const ACTOR_ID = "actor-1";
const MEMBER_ID = "member-1";

describe("OrgMembershipService member status guards", () => {
  let svc: OrgMembershipService;
  const findFirst = jest.fn();
  const revokeAllForUser = jest.fn().mockResolvedValue({ revokedCount: 0 });

  beforeEach(async () => {
    findFirst.mockReset();
    revokeAllForUser.mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgMembershipService,
        { provide: AblyService, useValue: { revokeUserTokens: jest.fn() } },
        {
          provide: EmailService,
          useValue: {
            sendMembershipRemovedEmail: jest.fn().mockResolvedValue(undefined),
            sendMembershipSuspendedEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        { provide: DRIZZLE, useValue: { query: { organizationMembers: { findFirst } } } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            cachedForOrg: jest.fn().mockImplementation(
              async (_orgId: string, _key: string, fn: () => Promise<unknown>) => fn(),
            ),
            cachedVersionedForOrg: jest.fn().mockImplementation(
              async (_orgId: string, _ns: string, _key: string, fn: () => Promise<unknown>) => fn(),
            ),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidate: jest.fn(),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: SessionsService, useValue: { revokeAllForUser } },
        {
          provide: AccessService,
          useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) },
        },
      ],
    }).compile();
    svc = moduleRef.get(OrgMembershipService);
  });

  describe("suspendMember", () => {
    it("throws NotFound when the member does not exist", async () => {
      findFirst.mockResolvedValue(undefined);
      await expect(svc.suspendMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it("refuses to suspend the organization owner", async () => {
      findFirst.mockResolvedValue({ isOwner: true, status: "ACTIVE", id: 1 });
      await expect(svc.suspendMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it("rejects an already-suspended member", async () => {
      findFirst.mockResolvedValue({ isOwner: false, status: "SUSPENDED", id: 1 });
      await expect(svc.suspendMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe("reactivateMember", () => {
    it("throws NotFound when the member does not exist", async () => {
      findFirst.mockResolvedValue(undefined);
      await expect(svc.reactivateMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("rejects reactivating a member who is not suspended", async () => {
      findFirst.mockResolvedValue({ status: "ACTIVE" });
      await expect(svc.reactivateMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});

function makeSelectChain(result: unknown[], endWithLimit = false) {
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  const awaitableResult = () => {
    const awaitable: Record<string, unknown> = Object.create(chain);
    awaitable["then"] = (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(result).then(resolve);
    return awaitable;
  };
  chain.orderBy = jest.fn().mockImplementation(awaitableResult);
  chain.where = jest.fn().mockImplementation(awaitableResult);
  if (endWithLimit) {
    chain.for = jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(result),
    });
  } else {
    chain.for = jest.fn().mockResolvedValue(result);
  }
  chain.limit = jest.fn().mockResolvedValue(result);
  return chain;
}

function buildTxMock(selectResults: { result: unknown[]; endWithLimit?: boolean }[]) {
  let callIndex = 0;
  return {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockImplementation(() => {
      const entry = selectResults[callIndex++];
      return makeSelectChain(entry?.result ?? [], entry?.endWithLimit ?? false);
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

describe("OrgMembershipService — module-ownership guards", () => {
  const auditLog = jest.fn();
  const cacheInvalidate = jest.fn().mockResolvedValue(undefined);
  const cacheInvalidateNamespace = jest.fn().mockResolvedValue(undefined);
  const revokeAllForUser = jest.fn().mockResolvedValue({ revokedCount: 0 });

  async function buildService(dbValue: unknown): Promise<OrgMembershipService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgMembershipService,
        { provide: AblyService, useValue: { revokeUserTokens: jest.fn() } },
        {
          provide: EmailService,
          useValue: {
            sendMembershipRemovedEmail: jest.fn().mockResolvedValue(undefined),
            sendMembershipSuspendedEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
        { provide: DRIZZLE, useValue: dbValue },
        { provide: AuditService, useValue: { log: auditLog } },
        {
          provide: CacheService,
          useValue: {
            cachedForOrg: jest.fn().mockImplementation(
              async (_orgId: string, _key: string, fn: () => Promise<unknown>) => fn(),
            ),
            cachedVersionedForOrg: jest.fn().mockImplementation(
              async (_orgId: string, _ns: string, _key: string, fn: () => Promise<unknown>) => fn(),
            ),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidate: cacheInvalidate,
            invalidateNamespace: cacheInvalidateNamespace,
          },
        },
        { provide: SessionsService, useValue: { revokeAllForUser } },
        {
          provide: AccessService,
          useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Map()) },
        },
      ],
    }).compile();
    return moduleRef.get(OrgMembershipService);
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("removeMember", () => {
    it("rejects removal of a member who owns modules and names which modules", async () => {
      const tx = buildTxMock([
        { result: [{ isOwner: false, id: 7 }], endWithLimit: true },
        { result: [{ moduleKey: "hr" }, { moduleKey: "crm" }] },
      ]);
      const db = {
        transaction: jest.fn().mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      const err = await svc
        .removeMember(ORG_ID, ACTOR_ID, MEMBER_ID)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain("hr");
      expect((err as BadRequestException).message).toContain("crm");
      expect(revokeAllForUser).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("rejects removal of the org owner", async () => {
      const tx = buildTxMock([
        { result: [{ isOwner: true, id: 1 }], endWithLimit: true },
      ]);
      const db = {
        transaction: jest.fn().mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      await expect(svc.removeMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it("succeeds for a non-owner who owns no modules", async () => {
      const tx = buildTxMock([
        { result: [{ isOwner: false, id: 5 }], endWithLimit: true },
        { result: [] },
        { result: [] },
      ]);
      const db = {
        transaction: jest.fn().mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
        }),
      };
      const svc = await buildService(db);

      const result = await svc.removeMember(ORG_ID, ACTOR_ID, MEMBER_ID);

      expect(result).toEqual({ success: true });
      expect(revokeAllForUser).not.toHaveBeenCalled();
      expect(tx.update).toHaveBeenCalled();
      expect(auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "org.member_removed" }),
      );
    });

    it("converts a raw FK violation (23503 backstop) to BadRequestException", async () => {
      const db = {
        transaction: jest.fn().mockRejectedValue({ code: "23503" }),
      };
      const svc = await buildService(db);

      await expect(svc.removeMember(ORG_ID, ACTOR_ID, MEMBER_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe("updateMemberRole", () => {
    it("rejects a role change when the member owns modules and names which modules", async () => {
      const tx = buildTxMock([
        { result: [{ isOwner: false }] },
        { result: [{ id: 9 }], endWithLimit: true },
        { result: [{ moduleKey: "build" }] },
      ]);
      const db = {
        transaction: jest.fn().mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      const err = await svc
        .updateMemberRole(ORG_ID, { userId: ACTOR_ID, isOrgOwner: true }, MEMBER_ID, "MEMBER")
        .catch((e: unknown) => e);

      if (!(err instanceof BadRequestException)) throw err;
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain("build");
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when member does not exist", async () => {
      const tx = buildTxMock([
        { result: [] },
        { result: [], endWithLimit: true },
      ]);
      const db = {
        transaction: jest.fn().mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      await expect(
        svc.updateMemberRole(ORG_ID, { userId: ACTOR_ID, isOrgOwner: true }, MEMBER_ID, "MEMBER"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("leaveOrg", () => {
    it("rejects leaving when the member owns modules and names which modules", async () => {
      const findFirst = jest.fn().mockResolvedValue({ isOwner: false, id: 3 });
      const tx = buildTxMock([
        { result: [{ moduleKey: "inventory" }] },
      ]);
      const db = {
        query: { organizationMembers: { findFirst } },
        transaction: jest.fn().mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      const err = await svc.leaveOrg(ORG_ID, MEMBER_ID).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain("inventory");
    });

    it("rejects leaving when the user is the org owner", async () => {
      const findFirst = jest.fn().mockResolvedValue({ isOwner: true, id: 1 });
      const db = {
        query: { organizationMembers: { findFirst } },
      };
      const svc = await buildService(db);

      await expect(svc.leaveOrg(ORG_ID, MEMBER_ID)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("suspendMember — module ownership block", () => {
    it("rejects suspension when the member owns modules and names which modules", async () => {
      const findFirst = jest.fn().mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 4 });
      const tx = buildTxMock([
        { result: [{ moduleKey: "payroll" }] },
      ]);
      const db = {
        query: { organizationMembers: { findFirst } },
        transaction: jest.fn().mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      const err = await svc
        .suspendMember(ORG_ID, ACTOR_ID, MEMBER_ID)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain("payroll");
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it("preserves the selected suspended org and invalidates again after commit", async () => {
      const findFirst = jest.fn().mockResolvedValue({
        isOwner: false,
        status: "ACTIVE",
        id: 4,
      });
      const tx = buildTxMock([
        { result: [] },
        { result: [] },
      ]);
      const db = {
        query: { organizationMembers: { findFirst } },
        transaction: jest.fn().mockImplementation(
          async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx),
        ),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      const svc = await buildService(db);
      const afterCommit: AfterCommitHook[] = [];

      await runWithTenantContext(
        {
          orgId: ORG_ID,
          audience: "INTERNAL",
          tx: tx as never,
          afterCommit,
        },
        () => svc.suspendMember(ORG_ID, ACTOR_ID, MEMBER_ID),
      );

      expect(tx.delete).toHaveBeenCalledWith(orgUnitMembers);
      expect(revokeAllForUser).not.toHaveBeenCalled();
      expect(cacheInvalidate).toHaveBeenCalledWith(
        CACHE_KEYS.userSession(MEMBER_ID),
      );
      expect(tx.update).not.toHaveBeenCalledWith(users);
      expect(afterCommit).toHaveLength(1);

      await afterCommit[0]?.();
      expect(
        cacheInvalidate.mock.calls.filter(
          ([key]) => key === CACHE_KEYS.userSession(MEMBER_ID),
        ),
      ).toHaveLength(2);
    });

    it("selects the restored organization without changing global account state", async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce({ status: "SUSPENDED" })
        .mockResolvedValueOnce({
          isOwner: false,
          status: "SUSPENDED",
          id: 4,
        });
      const tx = buildTxMock([
        {
          result: [{ previousOrgId: null, activeOrgId: null }],
        },
      ]);
      const db = {
        query: { organizationMembers: { findFirst } },
        transaction: jest.fn().mockImplementation(
          async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      await svc.reactivateMember(ORG_ID, ACTOR_ID, MEMBER_ID);

      expect(tx.update).toHaveBeenCalledWith(users);
      const updateBuilder = tx.update.mock.results[1]?.value as {
        set: jest.Mock;
      };
      expect(updateBuilder.set).toHaveBeenCalledWith({
        lastActiveOrgId: ORG_ID,
      });
    });

    it("does not pull a restored member away from another active organization", async () => {
      const findFirst = jest
        .fn()
        .mockResolvedValueOnce({ status: "SUSPENDED" })
        .mockResolvedValueOnce({
          isOwner: false,
          status: "SUSPENDED",
          id: 4,
        });
      const tx = buildTxMock([
        {
          result: [
            { previousOrgId: "org-2", activeOrgId: "org-2" },
            { previousOrgId: "org-2", activeOrgId: null },
          ],
        },
      ]);
      const db = {
        query: { organizationMembers: { findFirst } },
        transaction: jest.fn().mockImplementation(
          async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      await svc.reactivateMember(ORG_ID, ACTOR_ID, MEMBER_ID);

      expect(tx.update).not.toHaveBeenCalledWith(users);
      expect(cacheInvalidate).toHaveBeenCalledWith(
        CACHE_KEYS.userSession(MEMBER_ID),
      );
    });
  });
});
