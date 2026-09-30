import { NotFoundException, ForbiddenException } from "@nestjs/common";
import * as projectAccessModule from "../project-crud/project-access";
import { ProjectsMembersService } from "./projects-members.service";
import type { Db } from "../../../../db/drizzle.module";

function makeMinimalDb(): Db {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    }),
  } as unknown as Db;
}

const ACCESS = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as never;
const USER = { orgId: "org-1", userId: "u-1", isOrgOwner: false, principal: { kind: "human-session", membershipId: 5, isOrgOwner: false } } as never;

describe("ProjectsMembersService.assertCanManageProject delegates to canonical assertCanManageProject from project-access", () => {
  it("propagates NotFoundException from canonical when project is absent", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertCanManageProject")
      .mockRejectedValueOnce(new NotFoundException("Project not found"));

    const svc = new ProjectsMembersService(
      makeMinimalDb(),
      { enqueue: jest.fn() } as never,
      ACCESS,
      {} as never,
      {} as never,
    );

    await expect(svc.assertCanManageProject(USER, 99)).rejects.toThrow(NotFoundException);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), USER, 99);
    spy.mockRestore();
  });

  it("propagates ForbiddenException from canonical when caller lacks manage authority", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertCanManageProject")
      .mockRejectedValueOnce(new ForbiddenException("forbidden"));

    const svc = new ProjectsMembersService(
      makeMinimalDb(),
      { enqueue: jest.fn() } as never,
      ACCESS,
      {} as never,
      {} as never,
    );

    await expect(svc.assertCanManageProject(USER, 99)).rejects.toThrow(ForbiddenException);
    spy.mockRestore();
  });
});

describe("ProjectsMembersService.assertProjectAccess delegates to canonical assertProjectAccess from project-access", () => {
  it("propagates NotFoundException from canonical when project is absent", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertProjectAccess")
      .mockRejectedValueOnce(new NotFoundException("Project not found"));

    const svc = new ProjectsMembersService(
      makeMinimalDb(),
      { enqueue: jest.fn() } as never,
      ACCESS,
      {} as never,
      {} as never,
    );

    await expect(svc.assertProjectAccess(USER, 99)).rejects.toThrow(NotFoundException);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), USER, 99);
    spy.mockRestore();
  });

  it("propagates ForbiddenException from canonical for an outsider", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertProjectAccess")
      .mockRejectedValueOnce(new ForbiddenException("forbidden"));

    const svc = new ProjectsMembersService(
      makeMinimalDb(),
      { enqueue: jest.fn() } as never,
      ACCESS,
      {} as never,
      {} as never,
    );

    await expect(svc.assertProjectAccess(USER, 99)).rejects.toThrow(ForbiddenException);
    spy.mockRestore();
  });
});
