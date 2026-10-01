import { ForbiddenException, NotFoundException } from "@nestjs/common";
import * as projectAccessModule from "../project-crud/project-access";
import { ProjectsBudgetService } from "./projects-budget.service";
import type { Db } from "../../../../db/drizzle.module";

const ACCESS = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as never;
const USER = { orgId: "org-1", userId: "u-1", isOrgOwner: false, principal: { kind: "human-session", membershipId: 5, isOrgOwner: false } } as never;

function makeDb(): Db {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockReturnThis(),
    }),
  } as unknown as Db;
}

describe("ProjectsBudgetService.getBudget delegates to canonical assertProjectAccess", () => {
  it("propagates NotFoundException from canonical when project is absent", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertProjectAccess")
      .mockRejectedValueOnce(new NotFoundException("Project not found"));

    const svc = new ProjectsBudgetService(makeDb(), ACCESS);

    await expect(svc.getBudget(USER, 99)).rejects.toThrow(NotFoundException);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), USER, 99);
    spy.mockRestore();
  });

  it("propagates ForbiddenException from canonical for an outsider (project exists, no access)", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertProjectAccess")
      .mockRejectedValueOnce(new ForbiddenException("forbidden"));

    const svc = new ProjectsBudgetService(makeDb(), ACCESS);

    await expect(svc.getBudget(USER, 99)).rejects.toThrow(ForbiddenException);
    spy.mockRestore();
  });
});

describe("ProjectsBudgetService.updateBudget delegates to canonical assertProjectAccess", () => {
  it("propagates NotFoundException from canonical when project is absent", async () => {
    const spy = jest
      .spyOn(projectAccessModule, "assertProjectAccess")
      .mockRejectedValueOnce(new NotFoundException("Project not found"));

    const svc = new ProjectsBudgetService(makeDb(), ACCESS);

    await expect(svc.updateBudget(USER, 99, { budget: 1000 })).rejects.toThrow(NotFoundException);
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), USER, 99);
    spy.mockRestore();
  });
});
