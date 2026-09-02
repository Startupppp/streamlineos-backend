import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChangeRequestsService } from "./change-requests.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeUser(orgId: string): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "EMPLOYEE",
    isOrgOwner: false,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, true),
  };
}

function makeAccess(permissions: string[]): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(permissions)),
  } as unknown as AccessService;
}

function membershipSelect(rows: unknown[][]): jest.Mock {
  let call = 0;
  return jest.fn(() => {
    const index = call;
    call++;
    const chain: Record<string, unknown> = {};
    chain["from"] = jest.fn(() => chain);
    chain["innerJoin"] = jest.fn(() => chain);
    chain["where"] = jest.fn(() => chain);
    chain["orderBy"] = jest.fn(() => chain);
    chain["limit"] = jest.fn(() => Promise.resolve(rows[index] ?? []));
    return chain;
  });
}

function makeMockDb(changeRequestRow: unknown = undefined): Db {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      changeRequests: { findFirst: jest.fn().mockResolvedValue(changeRequestRow) },
    },
    select: jest.fn(),
    transaction: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
  } as unknown as Db;
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("ChangeRequestsService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when change request belongs to a different org", async () => {
    const db = makeMockDb(undefined);
    const svc = new ChangeRequestsService(db, mockAudit, makeAccess(["build:manage"]));

    await expect(svc.getChangeRequest("org-attacker", 1, 99)).rejects.toThrow(NotFoundException);
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
    } as unknown as Db;

    const svc = new ChangeRequestsService(db, mockAudit, makeAccess(["build:manage"]));
    const result = await svc.getChangeRequest("org-1", 1, 1);
    expect(result).toEqual(crRow);
  });

  it("throws NotFoundException for project lookup with wrong org before listing change requests", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
        changeRequests: { findFirst: jest.fn() },
      },
      select: jest.fn(),
      transaction: jest.fn(),
    } as unknown as Db;

    const svc = new ChangeRequestsService(db, mockAudit, makeAccess(["build:manage"]));

    await expect(
      svc.listChangeRequests(makeUser("org-attacker"), 1, {}),
    ).rejects.toThrow(NotFoundException);
  });

  it("denies a same-org non-member without build:manage (project membership gate)", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        changeRequests: { findFirst: jest.fn() },
      },
      select: membershipSelect([[], []]),
      transaction: jest.fn(),
    } as unknown as Db;

    const svc = new ChangeRequestsService(
      db,
      mockAudit,
      makeAccess(["build:changerequests:view"]),
    );

    await expect(
      svc.listChangeRequests(makeUser("org-a"), 1, {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member without build:manage", async () => {
    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
        changeRequests: { findFirst: jest.fn() },
      },
      select: membershipSelect([[{ role: "MEMBER" }], []]),
      transaction: jest.fn(),
    } as unknown as Db;

    const svc = new ChangeRequestsService(
      db,
      mockAudit,
      makeAccess(["build:changerequests:view"]),
    );

    await expect(svc.listChangeRequests(makeUser("org-a"), 1, {})).resolves.toEqual([]);
  });
});
