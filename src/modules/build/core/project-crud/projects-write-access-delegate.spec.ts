import { NotFoundException } from "@nestjs/common";
import * as projectAccessModule from "./project-access";
import { ProjectsWriteService } from "./projects-write.service";
import type { Db } from "../../../../db/drizzle.module";

const ORG = "org-delegate-1";

function makeDb() {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(null) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    transaction: jest.fn(),
  } as unknown as Db;
}

describe("ProjectsWriteService.updateProject delegates the manage-and-lifecycle check to authorizeProjectUpdate from project-access", () => {
  it("calls authorizeProjectUpdate and propagates NotFoundException when the canonical raises it", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "authorizeProjectUpdate")
      .mockRejectedValueOnce(new NotFoundException("Project not found"));

    const svc = new ProjectsWriteService(
      makeDb(),
      { log: jest.fn() } as never,
      { resolveUserPermissions: jest.fn() } as never,
      { getProject: jest.fn() } as never,
    );

    await expect(
      svc.updateProject({ orgId: ORG, userId: "u-1", isOrgOwner: false, principal: { kind: "human-session", membershipId: 5, isOrgOwner: false } } as never, 42, { name: "x" }),
    ).rejects.toThrow(NotFoundException);

    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ orgId: ORG }), 42, false);

    spy.mockRestore();
  });

  it("calls authorizeProjectUpdate once per updateProject call, marking a status-free edit as no lifecycle change", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "authorizeProjectUpdate")
      .mockResolvedValue(undefined);

    const db = {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(null) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      transaction: jest.fn().mockResolvedValue(undefined),
    } as unknown as Db;

    const svc = new ProjectsWriteService(
      db,
      { log: jest.fn() } as never,
      { resolveUserPermissions: jest.fn() } as never,
      { getProject: jest.fn().mockResolvedValue({ id: 42 }) } as never,
    );

    await svc.updateProject(
      { orgId: ORG, userId: "u-1", isOrgOwner: false, principal: { kind: "human-session", membershipId: 5, isOrgOwner: false } } as never,
      42,
      { name: "renamed" },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 42, false);

    spy.mockRestore();
  });
});
