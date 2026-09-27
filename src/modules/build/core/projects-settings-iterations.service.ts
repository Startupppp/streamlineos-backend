import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { assertProjectInOrg } from "./project-access";
import type { UpdateIterationSettingsInput } from "./dto/iterations-settings.schemas";

export interface IterationSettings {
  defaultDurationWeeks: number;
  namingPrefix: string;
}

const DEFAULTS: IterationSettings = {
  defaultDurationWeeks: 2,
  namingPrefix: "Cycle",
};

@Injectable()
export class ProjectsSettingsIterationsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getSettings(orgId: string, projectId: number): Promise<IterationSettings> {
    await assertProjectInOrg(this.db, orgId, projectId);
    const [project] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");
    const stored = project.settings?.iterations;
    return {
      defaultDurationWeeks: stored?.defaultDurationWeeks ?? DEFAULTS.defaultDurationWeeks,
      namingPrefix: stored?.namingPrefix ?? DEFAULTS.namingPrefix,
    };
  }

  async updateSettings(
    orgId: string,
    projectId: number,
    input: UpdateIterationSettingsInput,
  ): Promise<IterationSettings> {
    await assertProjectInOrg(this.db, orgId, projectId);
    const [project] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");

    const existing = project.settings ?? { modules: { sprints: false, epics: false, timeTracking: false, wiki: false } };
    const nextIterations: IterationSettings = {
      defaultDurationWeeks:
        input.defaultDurationWeeks ?? existing.iterations?.defaultDurationWeeks ?? DEFAULTS.defaultDurationWeeks,
      namingPrefix:
        input.namingPrefix ?? existing.iterations?.namingPrefix ?? DEFAULTS.namingPrefix,
    };

    await this.db
      .update(projects)
      .set({ settings: { ...existing, iterations: nextIterations } })
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)));

    return nextIterations;
  }
}
