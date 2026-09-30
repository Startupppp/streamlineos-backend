import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { ProjectsWriteService } from "./projects-write.service";

describe("ProjectsWriteService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(projectRow: unknown | null) {
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
      },
    } as unknown as Db;
  }
  const audit = { log: jest.fn() } as never;
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as never;
  const projectsQuery = {} as never;

  it("throws NotFoundException when deleting a project from a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new ProjectsWriteService(db, audit, access, projectsQuery);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: true } as never;
    await expect(svc.deleteProject(u, 99)).rejects.toThrow(NotFoundException);
  });

  it("deletes project for the owning org (same-tenant control)", async () => {
    const project = { id: 10, orgId: OWNER_ORG, status: "active" };
    const deleteFn = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });
    const txFn = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
      delete: deleteFn,
    }));
    const db = { query: { projects: { findFirst: jest.fn().mockResolvedValue(project) } }, transaction: txFn } as unknown as Db;
    const svc = new ProjectsWriteService(db, audit, access, projectsQuery);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;
    await expect(svc.deleteProject(u, 10)).resolves.not.toThrow();
    expect(deleteFn).not.toHaveBeenCalled();
  });
});
