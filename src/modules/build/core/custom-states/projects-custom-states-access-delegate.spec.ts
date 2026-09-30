import { ForbiddenException, NotFoundException } from "@nestjs/common";
import * as projectAccessModule from "../project-crud/project-access";
import { ProjectsCustomStatesService } from "./projects-custom-states.service";
import type { Db } from "../../../../db/drizzle.module";

const ACCESS = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as never;
const USER = { orgId: "org-1", userId: "u-1", isOrgOwner: false, principal: { kind: "human-session", membershipId: 5, isOrgOwner: false } } as never;

function makeDb(statusRow: unknown = null): Db {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(statusRow !== null ? [statusRow] : []),
      orderBy: jest.fn().mockReturnThis(),
    }),
  } as unknown as Db;
}

describe("ProjectsCustomStatesService write operations delegate to canonical assertCanManageProject", () => {
  it("bulkReorderCustomStates propagates NotFoundException from canonical when project is absent", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertCanManageProject")
      .mockRejectedValueOnce(new NotFoundException("Project not found"));

    const svc = new ProjectsCustomStatesService(makeDb(), ACCESS);

    await expect(svc.bulkReorderCustomStates(USER, 99, { items: [] })).rejects.toThrow(NotFoundException);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), USER, 99);
    spy.mockRestore();
  });

  it("bulkReorderCustomStates propagates ForbiddenException from canonical when caller lacks manage authority", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertCanManageProject")
      .mockRejectedValueOnce(new ForbiddenException("forbidden"));

    const svc = new ProjectsCustomStatesService(makeDb(), ACCESS);

    await expect(svc.bulkReorderCustomStates(USER, 99, { items: [] })).rejects.toThrow(ForbiddenException);
    spy.mockRestore();
  });

  it("updateCustomState propagates NotFoundException from canonical when called after status exists", async () => {
    const existingStatus = { id: 1, projectId: 99, orgId: "org-1", name: "In Progress", type: "started", color: null, order: 0 };
    const spy = jest
      .spyOn(projectAccessModule, "assertCanManageProject")
      .mockRejectedValueOnce(new NotFoundException("Project not found"));

    const svc = new ProjectsCustomStatesService(makeDb(existingStatus), ACCESS);

    await expect(svc.updateCustomState(USER, 99, 1, { name: "In Review" })).rejects.toThrow(NotFoundException);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), USER, 99);
    spy.mockRestore();
  });
});
