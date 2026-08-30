import type { Db } from "../../../db/drizzle.module";
import { ProjectsQueryService } from "./projects-query.service";

describe("ProjectsQueryService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])), scopeFor: jest.fn().mockResolvedValue("all") } as never;
  const cache = { cachedVersioned: jest.fn().mockImplementation((_ns: unknown, _k: unknown, fn: () => unknown) => fn()), invalidateNamespace: jest.fn() } as never;
  const audit = { log: jest.fn() } as never;

  it("returns null for getProject on a different org (cross-tenant isolation)", async () => {
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue(null) } },
    } as unknown as Db;
    const svc = new ProjectsQueryService(db, cache, audit, access);
    const u = { orgId: ATTACKER_ORG, userId: "u1", isOrgOwner: false } as never;
    await expect(svc.getProject(u, 99)).rejects.toThrow();
  });

  it("returns project for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG, name: "Proj", statuses: [], members: [] };
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue(project) } },
    } as unknown as Db;
    const svc = new ProjectsQueryService(db, cache, audit, access);
    const u = { orgId: OWNER_ORG, userId: "u1", isOrgOwner: true } as never;
    const result = await svc.getProject(u, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});
