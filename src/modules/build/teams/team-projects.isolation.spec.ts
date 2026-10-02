import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { TeamProjectsService } from "./team-projects.service";
import type { TeamsService } from "./teams.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const ATTACKER_ORG = "org-attacker";
const TEAM_ID = 1;
const PROJECT_ID = 99;

function actorIn(orgId: string): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

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

const dialect = new PgDialect();

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

describe("TeamProjectsService — cross-tenant isolation (BOLA)", () => {
  it("listTeamProjects throws NotFoundException when team belongs to a different org (DENY)", async () => {
    const db = makeDb();
    const svc = new TeamProjectsService(db, makeTeams(ATTACKER_ORG), mockAudit, stubService<AccessService>({}));
    await expect(svc.listTeamProjects(actorIn(ATTACKER_ORG), TEAM_ID)).rejects.toThrow(NotFoundException);
  });

  it("addProject throws NotFoundException when team belongs to a different org — cross-org isolation", async () => {
    const db = makeDb();
    const svc = new TeamProjectsService(db, makeTeams(ATTACKER_ORG), mockAudit, stubService<AccessService>({}));
    await expect(svc.addProject(actorIn(ATTACKER_ORG), TEAM_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("removeProject throws NotFoundException when team belongs to a different org — cross-org isolation", async () => {
    const db = makeDb();
    const svc = new TeamProjectsService(db, makeTeams(ATTACKER_ORG), mockAudit, stubService<AccessService>({}));
    await expect(svc.removeProject(actorIn(ATTACKER_ORG), TEAM_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });
});

describe("TeamProjectsService.listTeamProjects — soft-deleted project exclusion", () => {
  it("WHERE clause includes is null on projects.deleted_at so soft-deleted projects are excluded (failing before fix)", async () => {
    let capturedWhere: unknown;
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockImplementation((cond: unknown) => {
      capturedWhere = cond;
      return { orderBy };
    });
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    const captureDb: Db = {
      select: jest.fn().mockReturnValue({ from }),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      insert: jest.fn(),
    } as unknown as Db;

    const svc = new TeamProjectsService(
      captureDb,
      makeTeams(),
      mockAudit,
      stubService<AccessService>({ scopeFor: jest.fn().mockResolvedValue("all") }),
    );
    await svc.listTeamProjects(actorIn("org-1"), TEAM_ID);

    const rendered = render(capturedWhere);
    expect(rendered).toMatch(/deleted_at" is null/i);
  });
});
