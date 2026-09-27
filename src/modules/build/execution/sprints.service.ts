import { GoneException, Inject, Injectable, Optional } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateSprintInput, UpdateSprintInput } from "./dto/iterations.schemas";
import { ProjectsWebhooksDispatchService } from "../core";

const FROZEN = "Sprints are frozen. Use /build/:projectId/cycles — Cycles are the only iteration identity.";

@Injectable()
export class SprintsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Optional() private readonly webhooksDispatch: ProjectsWebhooksDispatchService | null,
  ) {}

  async listSprints(_orgId: string, _projectId: number): Promise<never> {
    throw new GoneException(FROZEN);
  }

  async createSprint(_orgId: string, _projectId: number, _input: CreateSprintInput): Promise<never> {
    throw new GoneException(FROZEN);
  }

  async getSprint(_orgId: string, _projectId: number, _sprintId: number): Promise<never> {
    throw new GoneException(FROZEN);
  }

  async updateSprint(
    _orgId: string,
    _projectId: number,
    _sprintId: number,
    _input: UpdateSprintInput,
    _actorId?: string,
  ): Promise<never> {
    throw new GoneException(FROZEN);
  }

  async deleteSprint(_orgId: string, _projectId: number, _sprintId: number): Promise<never> {
    throw new GoneException(FROZEN);
  }
}
