import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { UpdatesService } from "./updates.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { AccessService } from "../../access/access.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  return chain;
}

type MockDb = {
  query: {
    projects: { findFirst: jest.Mock };
  };
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
};

function makeMockDb(): MockDb {
  return {
    query: {
      projects: { findFirst: jest.fn() },
    },
    select: jest.fn().mockReturnValue(makeSelectChain([{ role: "MEMBER" }])),
    insert: jest.fn(),
    update: jest.fn(),
  };
}

function makeAccess(perms: Set<string> = new Set()): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(perms),
  } as unknown as AccessService;
}

function makeUser(orgId: string, membershipId = 7, userId = "user-1"): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => jest.resetAllMocks());

describe("UpdatesService.listUpdates — cross-tenant isolation (BOLA)", () => {
  it("rejects a non-member with ForbiddenException before returning rows", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.listUpdates(makeUser("org-1"), 1, {})).rejects.toThrow(ForbiddenException);
  });

  it("allows a project member and returns a cursor page", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);

    const result = await svc.listUpdates(makeUser("org-1"), 1, {});
    expect(result).toMatchObject({ data: [], pagination: { hasMore: false, nextCursor: null } });
  });

  it("returns 404 when the project does not belong to the attacker's org", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue(undefined);
    db.select.mockReturnValueOnce(makeSelectChain([]));
    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.listUpdates(makeUser("org-attacker"), 1, {})).rejects.toThrow(NotFoundException);
  });
});

describe("UpdatesService.createUpdate — tenant isolation and membershipId binding", () => {
  it("stores the caller's membershipId as authorMembershipId", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select.mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]));

    let capturedValues: Record<string, unknown> | undefined;
    db.insert.mockImplementation(() => ({
      values: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
        capturedValues = vals;
        return {
          returning: jest.fn().mockResolvedValue([{
            id: 1,
            orgId: vals["orgId"],
            projectId: vals["projectId"],
            authorMembershipId: vals["authorMembershipId"],
            body: vals["body"],
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          }]),
        };
      }),
    }));

    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);
    await svc.createUpdate(makeUser("org-1", 42), 1, { body: "Sprint 3 is on track." });

    expect(capturedValues?.["authorMembershipId"]).toBe(42);
    expect(capturedValues?.["orgId"]).toBe("org-1");
    expect(capturedValues?.["projectId"]).toBe(1);
  });

  it("throws NotFoundException when project is not in the caller's org", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue(undefined);
    db.select.mockReturnValueOnce(makeSelectChain([]));
    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);

    await expect(
      svc.createUpdate(makeUser("org-attacker", 99), 1, { body: "Attack" }),
    ).rejects.toThrow(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("UpdatesService.editUpdate — body update with authz", () => {
  it("allows the author to edit their own update body", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    const updatedRow = {
      id: 5,
      orgId: "org-1",
      projectId: 1,
      authorMembershipId: 42,
      body: "updated body",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 5, authorMembershipId: 42 }]));
    db.update.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updatedRow]),
        }),
      }),
    });
    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);
    const result = await svc.editUpdate(makeUser("org-1", 42), 1, 5, { body: "updated body" });
    expect(result).toMatchObject({ id: 5, body: "updated body" });
  });

  it("allows a non-author with build:updates:manage to edit any update", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    const updatedRow = {
      id: 5,
      orgId: "org-1",
      projectId: 1,
      authorMembershipId: 99,
      body: "patched by manager",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 5, authorMembershipId: 99 }]));
    db.update.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updatedRow]),
        }),
      }),
    });
    const svc = new UpdatesService(
      db as unknown as Db,
      makeAccess(new Set(["build:updates:manage"])),
      mockAudit,
    );
    const result = await svc.editUpdate(makeUser("org-1", 7), 1, 5, { body: "patched by manager" });
    expect(result).toMatchObject({ id: 5, body: "patched by manager" });
  });

  it("throws ForbiddenException when caller is not the author and lacks manage permission", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 5, authorMembershipId: 99 }]));
    const svc = new UpdatesService(db as unknown as Db, makeAccess(new Set()), mockAudit);
    await expect(
      svc.editUpdate(makeUser("org-1", 7), 1, 5, { body: "sneaky edit" }),
    ).rejects.toThrow(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when update does not exist in this project", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([]));
    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);
    await expect(
      svc.editUpdate(makeUser("org-1", 42), 1, 99, { body: "ghost edit" }),
    ).rejects.toThrow(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when project is not in the caller's org", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue(undefined);
    db.select.mockReturnValueOnce(makeSelectChain([]));
    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);
    await expect(
      svc.editUpdate(makeUser("org-attacker", 42), 1, 5, { body: "cross-org edit" }),
    ).rejects.toThrow(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("UpdatesService.softDeleteUpdate — soft-delete filtering and author ownership", () => {
  it("throws NotFoundException when update belongs to a different org", async () => {
    const db = makeMockDb();
    db.select.mockReturnValueOnce(makeSelectChain([]));
    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);

    await expect(svc.softDeleteUpdate(makeUser("org-attacker"), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("allows the author to delete their own update", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    const updateRow = {
      id: 5,
      orgId: "org-1",
      projectId: 1,
      authorMembershipId: 7,
      body: "Update body",
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(makeSelectChain([updateRow]));
    const updateChain = { set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(undefined) };
    db.update.mockReturnValue(updateChain);

    const svc = new UpdatesService(db as unknown as Db, makeAccess(), mockAudit);
    await svc.softDeleteUpdate(makeUser("org-1", 7), 1, 5);

    expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: expect.any(Date) }));
  });

  it("rejects a non-author without build:updates:manage from deleting another member's update", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select
      .mockReturnValueOnce(makeSelectChain([{ role: "MEMBER" }]))
      .mockReturnValueOnce(
        makeSelectChain([
          {
            id: 5,
            orgId: "org-1",
            projectId: 1,
            authorMembershipId: 99,
            body: "Owner's update",
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ]),
      );
    const svc = new UpdatesService(db as unknown as Db, makeAccess(new Set()), mockAudit);

    await expect(svc.softDeleteUpdate(makeUser("org-1", 7), 1, 5)).rejects.toThrow(ForbiddenException);
  });

  it("checks project access before reading the update, so a manage key in the org cannot delete inside a project the caller cannot reach", async () => {
    const db = makeMockDb();
    db.query.projects.findFirst.mockResolvedValue({ managerMembershipId: 999 });
    db.select.mockReturnValue(makeSelectChain([]));
    const svc = new UpdatesService(
      db as unknown as Db,
      makeAccess(new Set(["build:updates:manage"])),
      mockAudit,
    );

    await expect(svc.softDeleteUpdate(makeUser("org-1", 7), 1, 5)).rejects.toThrow(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
  });
});
