import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../../db/drizzle.constants";
import { CacheService } from "../../../../../common/cache/cache.service";
import { AccessService } from "../../../../access/access.service";
import { MANAGER_STANDING, standingAccess } from "../../project-crud/__tests__/project-access-doubles";
import { ProjectsAnalyticsService } from "../projects-analytics.service";

export async function analyticsService(db: object, cache: object): Promise<ProjectsAnalyticsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsAnalyticsService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: cache },
      { provide: AccessService, useValue: standingAccess(MANAGER_STANDING) },
    ],
  }).compile();
  return moduleRef.get(ProjectsAnalyticsService);
}
