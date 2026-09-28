import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { projects } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { forEachOrg } from "../../common/tenant";
import { logger } from "../../common/logger/logger.service";
import { ProjectsReportsService } from "../build/core";
import { systemActor } from "../../common/auth/system-actor";

// How many ACTIVE projects to snapshot per org per run.
// Orgs exceeding this cap have the overflow counted in projectsSkipped and
// a warning logged — the cap prevents a single large org from starving the sweep.
const PROJECTS_PER_ORG_CAP = 200;

export interface DailySnapshotResult {
  orgsVisited: number;
  orgsFailed: number;
  projectsProcessed: number;
  projectsSkipped: number;
  projectsFailed: number;
}

@Injectable()
export class CronBuildSnapshotsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly projectsReports: ProjectsReportsService,
  ) {}

  async snapshotAllProjects(): Promise<DailySnapshotResult> {
    let projectsProcessed = 0;
    let projectsSkipped = 0;
    let projectsFailed = 0;

    const orgResult = await forEachOrg(
      this.db,
      "build-daily-snapshots",
      async (tx, orgId) => {
        // Fetch one extra row to detect overflow without a COUNT query.
        // Only ACTIVE projects need daily snapshot rows; COMPLETED and ARCHIVED
        // have no ongoing ticket movement so their rows would never change.
        const rows = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.orgId, orgId), eq(projects.status, "ACTIVE")))
          .limit(PROJECTS_PER_ORG_CAP + 1);

        const overflowCount = Math.max(0, rows.length - PROJECTS_PER_ORG_CAP);
        const batch = rows.slice(0, PROJECTS_PER_ORG_CAP);

        if (overflowCount > 0) {
          projectsSkipped += overflowCount;
          logger.warn("[build-daily-snapshots] org exceeds per-org project cap — overflow omitted", {
            orgId,
            cap: PROJECTS_PER_ORG_CAP,
            overflowCount,
          });
        }

        for (const row of batch) {
          try {
            await this.projectsReports.snapshot(systemActor("build.daily-snapshots", orgId), row.id);
            projectsProcessed++;
          } catch (err) {
            projectsFailed++;
            logger.error("[build-daily-snapshots] project snapshot failed", {
              orgId,
              projectId: row.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
    );

    logger.info("[build-daily-snapshots] sweep complete", {
      orgsVisited: orgResult.organizations,
      orgsFailed: orgResult.failed,
      projectsProcessed,
      projectsSkipped,
      projectsFailed,
    });

    return {
      orgsVisited: orgResult.organizations,
      orgsFailed: orgResult.failed,
      projectsProcessed,
      projectsSkipped,
      projectsFailed,
    };
  }
}
