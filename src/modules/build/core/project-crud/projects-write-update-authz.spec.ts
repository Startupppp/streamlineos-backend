import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsWriteService } from "./projects-write.service";
import { MEMBER_STANDING, projectAccessRow, standingAccess, type ProjectAccessRow } from "../../__tests__/project-access-doubles";

const ORG = "org-authz-1";

function makeDb(projectRow: ProjectAccessRow | null) {
  const limit = jest.fn().mockResolvedValue(projectRow ? [projectRow] : []);
  return {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn(() => ({ limit })) })) })),
    query: {
      organizationMembers: { findFirst: jest.fn() },
    },
    transaction: jest.fn(),
  } as unknown as Db;
}

function makeService(db: Db) {
  return new ProjectsWriteService(
    db,
    { log: jest.fn() } as never,
    standingAccess(MEMBER_STANDING) as never,
    { getProject: jest.fn().mockResolvedValue({ id: 42 }) } as never,
  );
}

describe("ProjectsWriteService.updateProject — non-existent project authorization", () => {
  const user = {
    orgId: ORG,
    userId: "non-admin-user",
    isOrgOwner: false,
    principal: { kind: "human-session" as const, membershipId: 99, isOrgOwner: false },
  } as never;

  it("throws NotFoundException (not ForbiddenException) when non-admin requests an update on a non-existent project", async () => {
    await expect(
      makeService(makeDb(null)).updateProject(user, 9999, { name: "new name" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("does not expose ForbiddenException for a missing project — that leaks existence to an attacker", async () => {
    await expect(
      makeService(makeDb(null)).updateProject(user, 9999, { name: "new name" }),
    ).rejects.not.toThrow(ForbiddenException);
  });

  it("still throws ForbiddenException when the project EXISTS but the caller is not the manager or admin", async () => {
    await expect(
      makeService(makeDb(projectAccessRow({ memberRole: "CONTRIBUTOR" }))).updateProject(user, 42, { name: "new name" }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses a field edit on an archived project the caller manages with PROJECT_LOCKED", async () => {
    const attempt = makeService(makeDb(projectAccessRow({ manages: true, state: "ARCHIVED" }))).updateProject(user, 42, { name: "new name" });
    await expect(attempt).rejects.toThrow(ConflictException);
    await expect(attempt).rejects.toMatchObject({ response: { code: "PROJECT_LOCKED" } });
  });

  it("lets the manager of an archived project reopen it, because a status change is the way out of the lock", async () => {
    const db = makeDb(projectAccessRow({ manages: true, state: "ARCHIVED" }));
    (db as unknown as { transaction: jest.Mock }).transaction.mockResolvedValue(undefined);
    await expect(makeService(db).updateProject(user, 42, { status: "ACTIVE" })).resolves.toEqual({ id: 42 });
  });
});
