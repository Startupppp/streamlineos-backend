import { GoneException, NotFoundException } from "@nestjs/common";
import { listReleasesQuerySchema, ProjectsReleasesService, ProjectsWebhooksService } from "./core";
import { SprintsService } from "./execution/sprints.service";
import { EpicsService } from "./execution/epics.service";
import { CyclesService } from "./execution/cycles.service";
import { ModulesService } from "./execution/modules.service";
import { ProjectsCustomFieldsService, ProjectsAnalyticsService } from "./core";
import { CacheService } from "../../common/cache/cache.service";
import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { lifecycleAuditDouble } from "./lifecycle/audit-double";

const EXECUTE_ROWS: Record<string, unknown>[] = [
  { assigneeId: "u-analytics", assigneeName: "Ana Lytics", total: "3", completed: "1" },
];

function passThroughCache() {
  return {
    cachedVersioned: <T>(_namespace: string, _key: string, fetcher: () => Promise<T>) => fetcher(),
  } as unknown as CacheService;
}

function makeDb(project: { id: number } | undefined) {
  const rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const key of ["select", "from", "where", "orderBy", "limit", "offset", "leftJoin", "innerJoin", "groupBy"])
    chain[key] = jest.fn(self);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(project) },
      tickets: { findFirst: jest.fn().mockResolvedValue(project), findMany: jest.fn().mockResolvedValue(rows) },
    },
    select: jest.fn(self),
    execute: jest.fn().mockResolvedValue(EXECUTE_ROWS),
  } as unknown as Db;
}

describe("build — a project-scoped list refuses a projectId the org does not own", () => {
  const ATTACKER_ORG = "org-attacker";

  const releasesAccess: AccessService = {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])),
  } as unknown as AccessService;

  const releasesU: CurrentUserContext = {
    userId: "u-test",
    orgId: ATTACKER_ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };

  const cases: Array<[string, (db: Db) => Promise<unknown>]> = [
    ["GET /build/:projectId/releases", (db) => new ProjectsReleasesService(db, releasesAccess, lifecycleAuditDouble()).listReleases(releasesU, 1, listReleasesQuerySchema.parse({}))],
    ["GET /build/:projectId/webhooks", (db) => new ProjectsWebhooksService(db).listWebhooks(ATTACKER_ORG, 1)],
    ["GET /build/:projectId/epics", (db) => new EpicsService(db).listEpics(ATTACKER_ORG, 1)],
    ["GET /build/:projectId/cycles", (db) => new CyclesService(db).listCycles(ATTACKER_ORG, 1, {} as never)],
    ["GET /build/:projectId/modules", (db) => new ModulesService(db).listModules(ATTACKER_ORG, 1)],
    [
      "GET /build/:projectId/custom-fields",
      (db) => new ProjectsCustomFieldsService(db, releasesAccess).listFields(ATTACKER_ORG, 1),
    ],
    [
      "GET /build/:projectId/analytics",
      (db) =>
        new ProjectsAnalyticsService(db, passThroughCache()).getProjectAnalytics(ATTACKER_ORG, 1),
    ],
  ];

  it.each(cases)("%s answers 404 for a foreign project", async (_name, call) => {
    await expect(call(makeDb(undefined))).rejects.toThrow(NotFoundException);
  });

  it.each(cases)("%s still runs for a project the org owns (control)", async (_name, call) => {
    await expect(call(makeDb({ id: 1 }))).resolves.toBeDefined();
  });

  it("GET /build/:projectId/analytics control reaches the raw execute() aggregate past the gate, so a resolved control is not an unreached one", async () => {
    const db = makeDb({ id: 1 });
    const result = await new ProjectsAnalyticsService(db, passThroughCache()).getProjectAnalytics(ATTACKER_ORG, 1);

    expect(result.assigneeCompletion).toEqual([
      { assigneeId: "u-analytics", assigneeName: "Ana Lytics", total: 3, completed: 1 },
    ]);
    expect((db as unknown as { execute: jest.Mock }).execute).toHaveBeenCalledTimes(1);
  });

  it("GET /build/:projectId/sprints is frozen rather than project-gated, so it answers 410 for the owning org too and never becomes an existence oracle", async () => {
    await expect(new SprintsService(makeDb(undefined), null).listSprints(ATTACKER_ORG, 1)).rejects.toThrow(GoneException);
    await expect(new SprintsService(makeDb({ id: 1 }), null).listSprints(ATTACKER_ORG, 1)).rejects.toThrow(GoneException);
  });

  it("GET /build/:projectId/analytics never reaches execute() for a foreign project, so the 404 is the gate and not a downstream failure", async () => {
    const db = makeDb(undefined);
    await expect(new ProjectsAnalyticsService(db, passThroughCache()).getProjectAnalytics(ATTACKER_ORG, 1)).rejects.toThrow(
      NotFoundException,
    );

    expect((db as unknown as { execute: jest.Mock }).execute).not.toHaveBeenCalled();
  });
});
