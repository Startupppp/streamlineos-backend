import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { ProjectsSettingsIterationsService } from "./projects-settings-iterations.service";
import { MEMBER_STANDING, projectAccessRow, standingAccess, type ProjectAccessRow } from "../project-crud/__tests__/project-access-doubles";

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

async function build(standing: Standing) {
  const projectChain = { from: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(standing === undefined ? [] : [standing]) };
  projectChain.from.mockReturnValue(projectChain);
  projectChain.where.mockReturnValue(projectChain);
  const settingsChain = {
    from: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue([{ settings: null }]),
  };
  settingsChain.from.mockReturnValue(settingsChain);
  settingsChain.where.mockReturnValue(settingsChain);
  const select = jest.fn((projection: Record<string, unknown>) => {
    if ("settings" in projection) return settingsChain;
    return projectChain;
  });
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const update = jest.fn(() => ({ set: jest.fn(() => ({ where: updateWhere })) }));
  const db = {
    select,
    update,
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsSettingsIterationsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: standingAccess(MEMBER_STANDING) },
    ],
  }).compile();
  return { service: moduleRef.get(ProjectsSettingsIterationsService), update };
}

describe("PATCH /build/:projectId/settings/iterations requires manage standing on the project", () => {
  it("answers 403 to a project member who does not manage the project, without writing", async () => {
    const { service, update } = await build(PLAIN_MEMBER);
    await expect(service.updateSettings(caller, PROJECT_ID, { namingPrefix: "Sprint" })).rejects.toThrow(
      ForbiddenException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("answers 403 to a same-org caller who is not on the project, without writing", async () => {
    const { service, update } = await build(NON_MEMBER);
    await expect(service.updateSettings(caller, PROJECT_ID, { namingPrefix: "Sprint" })).rejects.toThrow(
      ForbiddenException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("answers 404 for a project outside the caller's tenant, without writing", async () => {
    const { service, update } = await build(FOREIGN);
    await expect(service.updateSettings(caller, PROJECT_ID, { namingPrefix: "Sprint" })).rejects.toThrow(
      NotFoundException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("saves the settings for the project's manager", async () => {
    const { service, update } = await build(MANAGER);
    await expect(service.updateSettings(caller, PROJECT_ID, { namingPrefix: "Sprint" })).resolves.toEqual({
      defaultDurationWeeks: 2,
      namingPrefix: "Sprint",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("GET /build/:projectId/settings/iterations conceals a project the caller cannot see", () => {
  it("answers 404 to a same-org caller who is not on the project", async () => {
    const { service } = await build(NON_MEMBER);
    await expect(service.getSettings(caller, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("answers 404 for a project outside the caller's tenant", async () => {
    const { service } = await build(FOREIGN);
    await expect(service.getSettings(caller, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns the defaults to a plain project member", async () => {
    const { service } = await build(PLAIN_MEMBER);
    await expect(service.getSettings(caller, PROJECT_ID)).resolves.toEqual({
      defaultDurationWeeks: 2,
      namingPrefix: "Cycle",
    });
  });
});
