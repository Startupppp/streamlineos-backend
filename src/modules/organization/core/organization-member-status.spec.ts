import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { OrgMembershipService } from "./org-membership.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { SessionsService } from "../../sessions/sessions.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

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
        { provide: DRIZZLE, useValue: { query: { organizationMembers: { findFirst } } } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CacheService, useValue: { invalidate: jest.fn(), invalidatePattern: jest.fn().mockResolvedValue(undefined) } },
        { provide: SessionsService, useValue: { revokeAllForUser } },
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
  chain.where = jest.fn().mockImplementation(() => {
    const awaitable: Record<string, unknown> = Object.create(chain);
    awaitable["then"] = (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(result).then(resolve);
    return awaitable;
  });
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
  const cacheInvalidatePattern = jest.fn().mockResolvedValue(undefined);
  const revokeAllForUser = jest.fn().mockResolvedValue({ revokedCount: 0 });

  async function buildService(dbValue: unknown): Promise<OrgMembershipService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgMembershipService,
        { provide: DRIZZLE, useValue: dbValue },
        { provide: AuditService, useValue: { log: auditLog } },
        { provide: CacheService, useValue: { invalidate: cacheInvalidate, invalidatePattern: cacheInvalidatePattern } },
        { provide: SessionsService, useValue: { revokeAllForUser } },
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
      };
      const svc = await buildService(db);

      const result = await svc.removeMember(ORG_ID, ACTOR_ID, MEMBER_ID);

      expect(result).toEqual({ success: true });
      expect(revokeAllForUser).toHaveBeenCalledWith(MEMBER_ID);
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
        .updateMemberRole(ORG_ID, ACTOR_ID, MEMBER_ID, "VIEWER")
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain("build");
      expect(auditLog).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when member does not exist", async () => {
      const tx = buildTxMock([
        { result: [], endWithLimit: true },
      ]);
      const db = {
        transaction: jest.fn().mockImplementation(
          async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
        ),
      };
      const svc = await buildService(db);

      await expect(
        svc.updateMemberRole(ORG_ID, ACTOR_ID, MEMBER_ID, "VIEWER"),
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
  });
});
