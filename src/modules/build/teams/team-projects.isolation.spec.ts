import { NotFoundException } from "@nestjs/common";
import { TeamProjectsService } from "./team-projects.service";
import type { TeamsService } from "./teams.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const TEAM_ID = 1;
const PROJECT_ID = 99;

function makeTeams(throwForOrg?: string): TeamsService {
  return {
    loadTeam: jest.fn().mockImplementation((orgId: string) => {
      if (throwForOrg && orgId === throwForOrg) throw new NotFoundException("Team not found");
      return Promise.resolve({ id: TEAM_ID, orgId, name: "Alpha" });
    }),
  } as unknown as TeamsService;
}

function makeDb(): Db {
  const limit = jest.fn().mockResolvedValue([]);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const orderBy = jest.fn().mockReturnValue({ limit });
  const whereOrderBy = jest.fn().mockReturnValue({ orderBy });
  const innerJoin = jest.fn().mockReturnValue({ where: whereOrderBy });
  const fromJoin = jest.fn().mockReturnValue({ innerJoin });
  return {
    select: jest.fn().mockReturnValue({ from: fromJoin }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
    insert: jest.fn(),
  } as unknown as Db;
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => jest.resetAllMocks());

describe("TeamProjectsService — cross-tenant isolation (BOLA)", () => {
  it("listTeamProjects throws NotFoundException when team belongs to a different org (DENY)", async () => {
    const db = makeDb();
    const svc = new TeamProjectsService(db, makeTeams(ATTACKER_ORG), mockAudit);
    await expect(svc.listTeamProjects(ATTACKER_ORG, TEAM_ID)).rejects.toThrow(NotFoundException);
  });

  it("addProject throws NotFoundException when team belongs to a different org — cross-org isolation", async () => {
    const db = makeDb();
    const svc = new TeamProjectsService(db, makeTeams(ATTACKER_ORG), mockAudit);
    await expect(svc.addProject(ATTACKER_ORG, "actor-1", TEAM_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("removeProject throws NotFoundException when team belongs to a different org — cross-org isolation", async () => {
    const db = makeDb();
    const svc = new TeamProjectsService(db, makeTeams(ATTACKER_ORG), mockAudit);
    await expect(svc.removeProject(ATTACKER_ORG, "actor-1", TEAM_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });
});
