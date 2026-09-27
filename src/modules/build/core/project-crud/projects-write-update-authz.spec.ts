import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsWriteService } from "./projects-write.service";

const ORG = "org-authz-1";

function makeAccess(hasManage: boolean) {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(
      hasManage ? new Set(["build:manage"]) : new Set<string>(),
    ),
  } as never;
}

function makeDb(projectRow: unknown | null) {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
      organizationMembers: { findFirst: jest.fn() },
    },
  } as unknown as Db;
}

describe("ProjectsWriteService.updateProject — non-existent project authorization", () => {
  const user = {
    orgId: ORG,
    userId: "non-admin-user",
    isOrgOwner: false,
    principal: { kind: "human-session" as const, membershipId: 99, isOrgOwner: false },
  } as never;

  it("throws NotFoundException (not ForbiddenException) when non-admin requests an update on a non-existent project", async () => {
    const db = makeDb(null);
    const svc = new ProjectsWriteService(
      db,
      { log: jest.fn() } as never,
      makeAccess(false),
      { getProject: jest.fn() } as never,
    );

    await expect(
      svc.updateProject(user, 9999, { name: "new name" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("does not expose ForbiddenException for a missing project — that leaks existence to an attacker", async () => {
    const db = makeDb(null);
    const svc = new ProjectsWriteService(
      db,
      { log: jest.fn() } as never,
      makeAccess(false),
      { getProject: jest.fn() } as never,
    );

    await expect(
      svc.updateProject(user, 9999, { name: "new name" }),
    ).rejects.not.toThrow(ForbiddenException);
  });

  it("still throws ForbiddenException when the project EXISTS but the caller is not the manager or admin", async () => {
    const db = makeDb({ managerMembershipId: 1 });
    (db as unknown as { query: { organizationMembers: { findFirst: jest.Mock } } }).query.organizationMembers.findFirst = jest.fn().mockResolvedValue(undefined);
    const dbWithMembers = {
      ...db,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      }),
    } as unknown as Db;
    (dbWithMembers as unknown as { query: { projects: { findFirst: jest.Mock }; organizationMembers: { findFirst: jest.Mock } } }).query = {
      projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 1 }) },
      organizationMembers: { findFirst: jest.fn() },
    };

    const svc = new ProjectsWriteService(
      dbWithMembers,
      { log: jest.fn() } as never,
      makeAccess(false),
      { getProject: jest.fn() } as never,
    );

    await expect(
      svc.updateProject(user, 42, { name: "new name" }),
    ).rejects.toThrow(ForbiddenException);
  });
});
