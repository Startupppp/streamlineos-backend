import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChangeRequestsService } from "./change-requests.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";

function makeU(orgId: string, isOrgOwner = false): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
}

function makeMockDb(changeRequestRow: unknown = undefined) {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      changeRequests: { findFirst: jest.fn().mockResolvedValue(changeRequestRow) },
    },
    select: jest.fn(),
    transaction: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
} as unknown as AccessService;

beforeEach(() => {
  jest.resetAllMocks();
  (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
});

describe("ChangeRequestsService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when change request belongs to a different org", async () => {
    const db = makeMockDb(undefined);
    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(svc.getChangeRequest("org-attacker", 1, 99)).rejects.toThrow(NotFoundException);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns the change request when orgId matches", async () => {
    const crRow = {
      id: 1,
      orgId: "org-1",
      projectId: 1,
      crNumber: 1,
      title: "Add feature",
      status: "PENDING",
      deletedAt: null,
    };
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        changeRequests: { findFirst: jest.fn().mockResolvedValue(crRow) },
      },
      select: jest.fn(),
      transaction: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
    };

    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);
    const result = await svc.getChangeRequest("org-1", 1, 1);
    expect(result).toEqual(crRow);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("throws NotFoundException for project lookup with wrong org before listing change requests", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        changeRequests: { findFirst: jest.fn() },
      },
      select: jest.fn(),
      transaction: jest.fn(),
    };

    const svc = new ChangeRequestsService(db as unknown as Db, mockAccess, mockAudit);

    await expect(
      svc.listChangeRequests(makeU("org-attacker"), 1, {}),
    ).rejects.toThrow(NotFoundException);

    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.query.changeRequests.findFirst).not.toHaveBeenCalled();
  });
});

describe("ChangeRequestsService — project membership gate (BOLA fix)", () => {
  const ORG = "org-1";
  const u = makeU(ORG);
  const gateAccess = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
  } as unknown as AccessService;

  function makeNonMemberDb() {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      transaction: jest.fn(),
      select: jest.fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
              }),
            }),
          }),
        }),
    };
  }

  function makeMemberDb(): Db {
    const postGateChain = {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    };
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      },
      select: jest.fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ role: "MEMBER" }]) }),
            }),
          }),
        })
        .mockReturnValue(postGateChain),
    } as unknown as Db;
  }

  beforeEach(() => {
    (gateAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Set());
  });

  it("rejects non-member with ForbiddenException on listChangeRequests", async () => {
    const db = makeNonMemberDb();
    const svc = new ChangeRequestsService(db as unknown as Db, gateAccess, mockAudit);
    await expect(svc.listChangeRequests(u, 1, {})).rejects.toThrow(ForbiddenException);

    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("allows direct project member on listChangeRequests", async () => {
    const db = makeMemberDb();
    const svc = new ChangeRequestsService(db, gateAccess, mockAudit);

    await expect(svc.listChangeRequests(u, 1, {})).resolves.toBeDefined();
  });
});
