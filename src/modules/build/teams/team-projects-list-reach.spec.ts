import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import {
  MANAGER_STANDING,
  MEMBER_STANDING,
  standingAccess,
  type StandingScopes,
} from "../core/project-crud/__tests__/project-access-doubles";
import { TeamProjectsService } from "./team-projects.service";
import { TeamsService } from "./teams.service";

const TEAM_ID = 4;
const TEAM_PROJECT = { id: 7, name: "Apollo", key: "APO", status: "ACTIVE", addedAt: new Date(0) };

const caller: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(21, false),
};

async function build(scopes: StandingScopes, teamInOrg = true) {
  const where = jest.fn((_condition: SQL) => ({ orderBy: () => ({ limit: () => Promise.resolve([TEAM_PROJECT]) }) }));
  const select = jest.fn(() => ({ from: () => ({ innerJoin: () => ({ where }) }) }));
  const loadTeam = teamInOrg
    ? jest.fn().mockResolvedValue({ id: TEAM_ID })
    : jest.fn().mockRejectedValue(new NotFoundException("Team not found"));
  const moduleRef = await Test.createTestingModule({
    providers: [
      TeamProjectsService,
      { provide: DRIZZLE, useValue: { select } },
      { provide: TeamsService, useValue: { loadTeam } },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: AccessService, useValue: standingAccess(scopes) },
    ],
  }).compile();
  return { select, where, svc: moduleRef.get(TeamProjectsService) };
}

function renderedWhere(where: jest.Mock): string {
  const condition: SQL | undefined = where.mock.calls[0]?.[0];
  return condition === undefined ? "" : new PgDialect().sqlToQuery(condition).sql;
}

describe("GET /build/teams/:teamId/projects lists only projects the caller reaches", () => {
  it("narrows a same-org member to projects they manage, belong to, or reach through a team", async () => {
    const built = await build(MEMBER_STANDING);
    await expect(built.svc.listTeamProjects(caller, TEAM_ID)).resolves.toEqual([TEAM_PROJECT]);
    const where = renderedWhere(built.where);
    expect(where).toContain('"build"."projects"."manager_membership_id" =');
    expect(where).toContain('"project_members"');
  });

  it("returns nothing and never queries for a caller with no Build project standing", async () => {
    const built = await build({});
    await expect(built.svc.listTeamProjects(caller, TEAM_ID)).resolves.toEqual([]);
    expect(built.select).not.toHaveBeenCalled();
  });

  it("answers 404 for a team outside the caller's organisation", async () => {
    const built = await build(MANAGER_STANDING, false);
    await expect(built.svc.listTeamProjects(caller, TEAM_ID)).rejects.toThrow(NotFoundException);
    expect(built.select).not.toHaveBeenCalled();
  });

  it("lists every assigned project for an organisation-wide build:manage holder (control)", async () => {
    const built = await build(MANAGER_STANDING);
    await expect(built.svc.listTeamProjects(caller, TEAM_ID)).resolves.toEqual([TEAM_PROJECT]);
    expect(renderedWhere(built.where)).not.toContain('"project_members"');
  });
});
