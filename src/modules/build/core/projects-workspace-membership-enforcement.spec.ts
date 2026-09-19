jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));
jest.mock("../../../common/organization/organization-actor", () => ({
  resolveOrganizationActorsByUserIds: jest.fn().mockResolvedValue(
    new Map([["user-abc", { membershipId: 10, organizationPersonId: "person-1" }]]),
  ),
}));

import { ForbiddenException } from "@nestjs/common";
import { ProjectsProvisionService } from "./projects-provision.service";
import { ProjectsQueryService } from "./projects-query.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-x";
const USER = "user-abc";
const WS = "ws-1";
const MEMBERSHIP_ID = 10;

function makeMinimalProvisionDb() {
  const txInsert = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 1, orgId: ORG, key: "P-001", name: "P" }]),
  };
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnValue(txInsert),
  };
  return {
    db: {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
      query: {},
    } as unknown as Db,
    tx,
  };
}

describe("ProjectsProvisionService — workspace membership enforcement on createProject (BSN-01-016)", () => {
  it("propagates ForbiddenException from assertMemberOfWorkspace when creator is not a workspace member", async () => {
    const { db } = makeMinimalProvisionDb();
    const pmWorkspaces = {
      resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
      assertMemberOfWorkspace: jest.fn().mockRejectedValue(new ForbiddenException("Not a member")),
    };

    const svc = new ProjectsProvisionService(
      db,
      { log: jest.fn() } as never,
      { assertWithinLimit: jest.fn() } as never,
      { emit: jest.fn() } as never,
      pmWorkspaces as never,
    );

    await expect(svc.createProject(ORG, USER, { name: "Project" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("never calls db.transaction when the creator is not a workspace member", async () => {
    const { db } = makeMinimalProvisionDb();
    const pmWorkspaces = {
      resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
      assertMemberOfWorkspace: jest.fn().mockRejectedValue(new ForbiddenException("Not a member")),
    };

    const svc = new ProjectsProvisionService(
      db,
      { log: jest.fn() } as never,
      { assertWithinLimit: jest.fn() } as never,
      { emit: jest.fn() } as never,
      pmWorkspaces as never,
    );

    await svc.createProject(ORG, USER, { name: "Project" }).catch(() => undefined);

    const dbMock = db as unknown as { transaction: jest.Mock };
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("calls assertMemberOfWorkspace with the resolved workspace and creator membership", async () => {
    const { db } = makeMinimalProvisionDb();
    const assertMemberOfWorkspace = jest.fn().mockRejectedValue(new ForbiddenException("Not a member"));
    const pmWorkspaces = {
      resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS),
      assertMemberOfWorkspace,
    };

    const svc = new ProjectsProvisionService(
      db,
      { log: jest.fn() } as never,
      { assertWithinLimit: jest.fn() } as never,
      { emit: jest.fn() } as never,
      pmWorkspaces as never,
    );

    await svc.createProject(ORG, USER, { name: "Project" }).catch(() => undefined);

    expect(assertMemberOfWorkspace).toHaveBeenCalledWith(ORG, WS, MEMBERSHIP_ID);
  });
});

describe("ProjectsQueryService — workspace membership enforcement on listProjects (BSN-01-011)", () => {
  function makeQueryDb() {
    const builder = {
      from: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinLateral: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockReturnThis(),
    };
    return {
      select: jest.fn().mockReturnValue(builder),
    } as unknown as Db;
  }

  const u = {
    orgId: ORG,
    userId: USER,
    isOrgOwner: false,
    principal: { kind: "human-session" as const, membershipId: MEMBERSHIP_ID, isOrgOwner: false },
  } as never;

  const adminU = {
    orgId: ORG,
    userId: USER,
    isOrgOwner: true,
    principal: { kind: "human-session" as const, membershipId: MEMBERSHIP_ID, isOrgOwner: true },
  } as never;

  it("propagates ForbiddenException from assertMemberOfWorkspace for a non-member with pmWorkspaceId filter", async () => {
    const db = makeQueryDb();
    const assertMemberOfWorkspace = jest.fn().mockRejectedValue(new ForbiddenException("Not a member"));
    const pmWorkspaces = { assertMemberOfWorkspace };
    const access = { scopeFor: jest.fn().mockResolvedValue("own") } as never;

    const svc = new ProjectsQueryService(db, { log: jest.fn() } as never, access, pmWorkspaces as never);

    await expect(
      svc.listProjects(u, { limit: 20, status: "ALL", pmWorkspaceId: WS }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("does not call assertMemberOfWorkspace when no pmWorkspaceId filter is provided", async () => {
    const db = makeQueryDb();
    const assertMemberOfWorkspace = jest.fn().mockResolvedValue(undefined);
    const pmWorkspaces = { assertMemberOfWorkspace };
    const access = { scopeFor: jest.fn().mockResolvedValue("own") } as never;

    const svc = new ProjectsQueryService(db, { log: jest.fn() } as never, access, pmWorkspaces as never);

    await svc.listProjects(u, { limit: 20, status: "ALL" });

    expect(assertMemberOfWorkspace).not.toHaveBeenCalled();
  });

  it("does not call assertMemberOfWorkspace for an unrestricted (build:manage) caller even with pmWorkspaceId filter", async () => {
    const db = makeQueryDb();
    const assertMemberOfWorkspace = jest.fn().mockResolvedValue(undefined);
    const pmWorkspaces = { assertMemberOfWorkspace };
    const access = { scopeFor: jest.fn().mockResolvedValue("all") } as never;

    const svc = new ProjectsQueryService(db, { log: jest.fn() } as never, access, pmWorkspaces as never);

    await svc.listProjects(adminU, { limit: 20, status: "ALL", pmWorkspaceId: WS });

    expect(assertMemberOfWorkspace).not.toHaveBeenCalled();
  });

  it("calls assertMemberOfWorkspace with correct orgId, workspaceId and callerMembershipId for restricted caller", async () => {
    const db = makeQueryDb();
    const assertMemberOfWorkspace = jest.fn().mockResolvedValue(undefined);
    const pmWorkspaces = { assertMemberOfWorkspace };
    const access = { scopeFor: jest.fn().mockResolvedValue("own") } as never;

    const svc = new ProjectsQueryService(db, { log: jest.fn() } as never, access, pmWorkspaces as never);

    await svc.listProjects(u, { limit: 20, status: "ALL", pmWorkspaceId: WS });

    expect(assertMemberOfWorkspace).toHaveBeenCalledWith(ORG, WS, MEMBERSHIP_ID);
  });
});
