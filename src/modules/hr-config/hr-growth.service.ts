import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { careerLadders, learningPaths } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateCareerLadderInput, CreateLearningPathInput } from "./dto/growth.schemas";

@Injectable()
export class HrGrowthService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listCareerLadders(orgId: string) {
    return this.db
      .select()
      .from(careerLadders)
      .where(eq(careerLadders.orgId, orgId))
      .orderBy(desc(careerLadders.createdAt));
  }

  createCareerLadder(orgId: string, input: CreateCareerLadderInput) {
    return this.db
      .insert(careerLadders)
      .values({
        orgId,
        title: input.title,
        department: input.department ?? null,
        description: input.description ?? null,
        levels: input.levels,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  listLearningPaths(orgId: string, limit: number) {
    return this.db.query.learningPaths.findMany({
      where: eq(learningPaths.orgId, orgId),
      orderBy: [desc(learningPaths.createdAt)],
      limit,
    });
  }

  createLearningPath(orgId: string, userId: string, input: CreateLearningPathInput) {
    return this.db
      .insert(learningPaths)
      .values({
        orgId,
        title: input.title,
        description: input.description,
        targetRole: input.targetRole,
        level: input.level,
        estimatedHours: input.estimatedHours,
        steps: input.steps,
        createdBy: userId,
      })
      .returning()
      .then((rows) => rows[0]);
  }
}
