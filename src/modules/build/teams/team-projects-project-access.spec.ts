import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { TeamProjectsService } from "./team-projects.service";
import { TeamsService } from "./teams.service";
import { MEMBER_STANDING, projectAccessRow, principalAccess, type ProjectAccessRow } from "../__tests__/project-access-doubles";

const TEAM_ID = 4;
const PROJECT_ID = 7;
const CALLER_MEMBERSHIP = 21;

const caller: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(CALLER_MEMBERSHIP, false),
};

type Standing = ProjectAccessRow | undefined;

const MANAGER: Standing = projectAccessRow({ manages: true });
const PLAIN_MEMBER: Standing = projectAccessRow({ memberRole: "MEMBER" });
const NON_MEMBER: Standing = projectAccessRow();
const FOREIGN: Standing = undefined;

function chainResolving(rows: unknown[]) {
  const chain = { from: jest.fn(), innerJoin: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(rows) };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

async function build(standing: Standing) {
  const projectChain = chainResolving(standing === undefined ? [] : [standing]);
  const emptyChain = chainResolving([]);
  const select = jest.fn((projection: Record<string, unknown>) =>
    "onTeam" in projection ? projectChain : emptyChain,
  );
  const returning = jest.fn().mockResolvedValue([{ id: 1, teamId: TEAM_ID, projectId: PROJECT_ID }]);
  const insert = jest.fn(() => ({ values: jest.fn(() => ({ returning })) }));
  const remove = jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) }));
  const db = {
    select,
    insert,
    delete: remove,
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      TeamProjectsService,
      { provide: DRIZZLE, useValue: db },
      { provide: TeamsService, useValue: { loadTeam: jest.fn().mockResolvedValue({ id: TEAM_ID }) } },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: AccessService, useValue: principalAccess(MEMBER_STANDING) },
    ],
  }).compile();
  return { service: moduleRef.get(TeamProjectsService), insert, remove };
}

describe("POST /build/teams/:teamId/projects cannot grant a team access to a project the caller does not manage", () => {
  it("answers 403 to a plain member of the project, without linking the team", async () => {
    const { service, insert } = await build(PLAIN_MEMBER);
    await expect(service.addProject(caller, TEAM_ID, PROJECT_ID)).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers 403 to a same-org caller who is not on the project, without linking the team", async () => {
    const { service, insert } = await build(NON_MEMBER);
    await expect(service.addProject(caller, TEAM_ID, PROJECT_ID)).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("answers 404 for a project outside the caller's tenant, without linking the team", async () => {
    const { service, insert } = await build(FOREIGN);
    await expect(service.addProject(caller, TEAM_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("links the team for the project's manager", async () => {
    const { service, insert } = await build(MANAGER);
    await expect(service.addProject(caller, TEAM_ID, PROJECT_ID)).resolves.toMatchObject({ projectId: PROJECT_ID });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /build/teams/:teamId/projects/:projectId cannot revoke a team's access to a project the caller does not manage", () => {
  it("answers 403 to a plain member of the project, without unlinking the team", async () => {
    const { service, remove } = await build(PLAIN_MEMBER);
    await expect(service.removeProject(caller, TEAM_ID, PROJECT_ID)).rejects.toThrow(ForbiddenException);
    expect(remove).not.toHaveBeenCalled();
  });

  it("answers 404 for a project outside the caller's tenant, without unlinking the team", async () => {
    const { service, remove } = await build(FOREIGN);
    await expect(service.removeProject(caller, TEAM_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
    expect(remove).not.toHaveBeenCalled();
  });

  it("unlinks the team for the project's manager", async () => {
    const { service, remove } = await build(MANAGER);
    await service.removeProject(caller, TEAM_ID, PROJECT_ID);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
