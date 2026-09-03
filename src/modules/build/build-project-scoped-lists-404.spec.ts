import { NotFoundException } from "@nestjs/common";
import { ProjectsReleasesService } from "./core/projects-releases.service";
import { ProjectsWebhooksService } from "./core/projects-webhooks.service";
import { SprintsService } from "./execution/sprints.service";
import { EpicsService } from "./execution/epics.service";
import { CyclesService } from "./execution/cycles.service";
import { ModulesService } from "./execution/modules.service";
import { ProjectsCustomFieldsService } from "./core/projects-custom-fields.service";
import { ProjectsAnalyticsService } from "./core/projects-analytics.service";
import type { Db } from "../../db/drizzle.module";

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
  } as unknown as Db;
}

describe("build — a project-scoped list refuses a projectId the org does not own", () => {
  const ATTACKER_ORG = "org-attacker";

  const cases: Array<[string, (db: Db) => Promise<unknown>]> = [
    ["GET /build/:projectId/releases", (db) => new ProjectsReleasesService(db).listReleases(ATTACKER_ORG, 1)],
    ["GET /build/:projectId/webhooks", (db) => new ProjectsWebhooksService(db).listWebhooks(ATTACKER_ORG, 1)],
    ["GET /build/:projectId/sprints", (db) => new SprintsService(db, null).listSprints(ATTACKER_ORG, 1)],
    ["GET /build/:projectId/epics", (db) => new EpicsService(db).listEpics(ATTACKER_ORG, 1)],
    ["GET /build/:projectId/cycles", (db) => new CyclesService(db).listCycles(ATTACKER_ORG, 1, {} as never)],
    ["GET /build/:projectId/modules", (db) => new ModulesService(db).listModules(ATTACKER_ORG, 1)],
    [
      "GET /build/:projectId/custom-fields",
      (db) => new ProjectsCustomFieldsService(db).listFields(ATTACKER_ORG, 1),
    ],
    [
      "GET /build/:projectId/analytics",
      (db) =>
        new ProjectsAnalyticsService(
          db,
          { cached: (_k: string, fn: () => Promise<unknown>) => fn() } as unknown as ConstructorParameters<
            typeof ProjectsAnalyticsService
          >[1],
        ).getProjectAnalytics(ATTACKER_ORG, 1),
    ],
  ];

  it.each(cases)("%s answers 404 for a foreign project", async (_name, call) => {
    await expect(call(makeDb(undefined))).rejects.toThrow(NotFoundException);
  });

  it.each(cases)("%s still runs for a project the org owns (control)", async (_name, call) => {
    await expect(call(makeDb({ id: 1 }))).resolves.toBeDefined();
  });
});
