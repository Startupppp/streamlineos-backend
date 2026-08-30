import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { IncidentsService } from "./incidents.service";

describe("IncidentsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const audit = { log: jest.fn() } as never;

  function makeDb(projectRow: unknown | null, incidentRow: unknown | null = null) {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue(projectRow) },
        projectIncidents: { findFirst: jest.fn().mockResolvedValue(incidentRow), findMany: jest.fn().mockResolvedValue([]) },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException when accessing incident for a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new IncidentsService(db, audit);
    await expect(svc.getIncident(ATTACKER_ORG, 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns incident for the owning org (same-tenant control)", async () => {
    const project = { id: 1, orgId: OWNER_ORG };
    const incident = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Outage" };
    const db = makeDb(project, incident);
    const svc = new IncidentsService(db, audit);
    const result = await svc.getIncident(OWNER_ORG, 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });
});
