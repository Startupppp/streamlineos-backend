import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { CacheService } from "../../../../common/cache/cache.service";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import {
  MEMBER_STANDING,
  projectAccessRow,
  standingAccess,
  type ProjectAccessRow,
} from "../../__tests__/project-access-doubles";
import { ProjectsAnalyticsService } from "./projects-analytics.service";

const PROJECT_ID = 7;

const actor: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(21, false),
};

function makeDb(project: ProjectAccessRow | null) {
  const projectRows = project === null ? [] : [project];
  const rows: object[] = [];
  const chain = {
    from: () => chain,
    where: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (value: object[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  const select = jest.fn((fields?: object) =>
    fields !== undefined && "memberRole" in fields
      ? { from: () => ({ where: () => ({ limit: () => Promise.resolve(projectRows) }) }) }
      : chain,
  );
  const execute = jest.fn().mockResolvedValue([]);
  return { select, execute };
}

async function build(project: ProjectAccessRow | null) {
  const db = makeDb(project);
  const cache = {
    cachedVersioned: jest.fn((_namespace: string, _key: string, fetcher: () => Promise<unknown>) => fetcher()),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsAnalyticsService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: cache },
      { provide: AccessService, useValue: standingAccess(MEMBER_STANDING) },
    ],
  }).compile();
  return { db, cache, svc: moduleRef.get(ProjectsAnalyticsService) };
}

describe("GET /build/:projectId/analytics is decided by the project-access aggregate rule", () => {
  it("answers 403 to a same-org caller with no relationship to the project, before any aggregate is read", async () => {
    const built = await build(projectAccessRow());
    await expect(built.svc.getProjectAnalytics(actor, PROJECT_ID)).rejects.toThrow(ForbiddenException);
    expect(built.cache.cachedVersioned).not.toHaveBeenCalled();
    expect(built.db.execute).not.toHaveBeenCalled();
  });

  it("answers 404 for a project outside the caller's organisation", async () => {
    const built = await build(null);
    await expect(built.svc.getProjectAnalytics(actor, PROJECT_ID)).rejects.toThrow(NotFoundException);
    expect(built.cache.cachedVersioned).not.toHaveBeenCalled();
  });

  it("computes the analytics for a project member whose ticket scope is unrestricted", async () => {
    const built = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(built.svc.getProjectAnalytics(actor, PROJECT_ID)).resolves.toBeDefined();
    expect(built.cache.cachedVersioned).toHaveBeenCalledTimes(1);
    expect(built.db.execute).toHaveBeenCalled();
  });
});
