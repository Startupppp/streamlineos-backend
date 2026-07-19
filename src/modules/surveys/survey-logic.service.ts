import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { surveyLogicRules } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SurveyVersionService } from "./survey-version.service";
import type { CreateLogicRuleInput, PatchLogicRuleInput } from "./dto/survey-builder.schemas";

@Injectable()
export class SurveyLogicService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly versions: SurveyVersionService,
  ) {}

  async list(orgId: string, surveyId: number) {
    const draft = await this.versions.getDraftVersion(orgId, surveyId);
    return this.db.query.surveyLogicRules.findMany({
      where: and(eq(surveyLogicRules.orgId, orgId), eq(surveyLogicRules.versionId, draft.id)),
      orderBy: [asc(surveyLogicRules.sortOrder)],
      limit: 100,
    });
  }

  async create(orgId: string, surveyId: number, input: CreateLogicRuleInput) {
    const draft = await this.versions.getDraftVersion(orgId, surveyId);
    const [rule] = await this.db
      .insert(surveyLogicRules)
      .values({
        orgId,
        surveyId,
        versionId: draft.id,
        sourceQuestionId: input.sourceQuestionId,
        condition: input.condition,
        action: input.action,
        target: input.target ?? null,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();
    return rule;
  }

  async patch(orgId: string, surveyId: number, ruleId: number, input: PatchLogicRuleInput) {
    const [updated] = await this.db
      .update(surveyLogicRules)
      .set(input)
      .where(and(eq(surveyLogicRules.id, ruleId), eq(surveyLogicRules.orgId, orgId), eq(surveyLogicRules.surveyId, surveyId)))
      .returning();
    if (!updated) throw new NotFoundException("Logic rule not found");
    return updated;
  }

  async delete(orgId: string, surveyId: number, ruleId: number) {
    const [deleted] = await this.db
      .delete(surveyLogicRules)
      .where(and(eq(surveyLogicRules.id, ruleId), eq(surveyLogicRules.orgId, orgId), eq(surveyLogicRules.surveyId, surveyId)))
      .returning();
    if (!deleted) throw new NotFoundException("Logic rule not found");
    return { success: true };
  }
}
