import type { Db } from "../../../db/drizzle.module";
import { ProjectsTicketsReadService } from "./projects-tickets-read.service";

describe("ProjectsTicketsReadService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as never;

  function makeDb(projectRow: unknown | null, memberRows: unknown[]) {
    const memberLimit = jest.fn().mockResolvedValue(memberRows);
    const memberWhere = jest.fn().mockReturnValue({ limit: memberLimit });
    const teamLimit = jest.fn().mockResolvedValue([]);
    const teamWhere = jest.fn().mockReturnValue({ limit: teamLimit });
    const teamInnerJoin = jest.fn().mockReturnValue({ where: teamWhere });
    const from = jest.fn().mockReturnValue({ where: memberWhere, innerJoin: teamInnerJoin });
    return {
      db: {
        query: { projects: { findFirst: jest.fn().mockResolvedValue(projectRow) } },
        select: jest.fn().mockReturnValue({ from }),
      } as unknown as Db,
    };
  }

  it("returns hasAccess=false for project in a different org (cross-tenant isolation)", async () => {
    const { db } = makeDb(null, []);
    const svc = new ProjectsTicketsReadService(db, access);
    const result = await svc.checkProjectAccess(ATTACKER_ORG, "u1", 99);
    expect(result.hasAccess).toBe(false);
  });

  it("returns hasAccess=true for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG, managerId: "u1" };
    const { db } = makeDb(project, []);
    const svc = new ProjectsTicketsReadService(db, access);
    const result = await svc.checkProjectAccess(OWNER_ORG, "u1", 1);
    expect(result.hasAccess).toBe(true);
  });
});
