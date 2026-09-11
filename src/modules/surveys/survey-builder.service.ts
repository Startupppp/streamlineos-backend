import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { surveySections, surveyQuestions, surveyQuestionChoices } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { bulkUpdateFromValues } from "../../common/db/bulk-update";
import { SurveyVersionService } from "./survey-version.service";
import type { CreateQuestionInput, CreateSectionInput, PatchQuestionInput, PatchSectionInput, ReorderInput } from "./dto/survey-builder.schemas";

@Injectable()
export class SurveyBuilderService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly versions: SurveyVersionService,
  ) {}

  async getBuilder(orgId: string, surveyId: number) {
    const draft = await this.versions.getDraftVersion(orgId, surveyId);
    return this.versions.buildSchemaSnapshot(orgId, draft.id);
  }

  async createSection(orgId: string, surveyId: number, input: CreateSectionInput) {
    const draft = await this.versions.getDraftVersion(orgId, surveyId);
    const [section] = await this.db
      .insert(surveySections)
      .values({
        orgId,
        surveyId,
        versionId: draft.id,
        title: input.title,
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? 0,
        settings: input.settings ?? {},
      })
      .returning();
    return section;
  }

  async patchSection(orgId: string, surveyId: number, sectionId: number, input: PatchSectionInput) {
    const [updated] = await this.db
      .update(surveySections)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(surveySections.id, sectionId), eq(surveySections.orgId, orgId), eq(surveySections.surveyId, surveyId)))
      .returning();
    if (!updated) throw new NotFoundException("Section not found");
    return updated;
  }

  async deleteSection(orgId: string, surveyId: number, sectionId: number) {
    const [deleted] = await this.db
      .delete(surveySections)
      .where(and(eq(surveySections.id, sectionId), eq(surveySections.orgId, orgId), eq(surveySections.surveyId, surveyId)))
      .returning();
    if (!deleted) throw new NotFoundException("Section not found");
    return { success: true };
  }

  async createQuestion(orgId: string, surveyId: number, input: CreateQuestionInput) {
    const draft = await this.versions.getDraftVersion(orgId, surveyId);
    const [question] = await this.db
      .insert(surveyQuestions)
      .values({
        orgId,
        surveyId,
        versionId: draft.id,
        sectionId: input.sectionId,
        questionKey: `q_${randomUUID().slice(0, 8)}`,
        variableName: input.variableName ?? null,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        required: input.required,
        settings: input.settings ?? {},
        validation: input.validation ?? {},
        scoring: input.scoring ?? {},
        sortOrder: input.sortOrder ?? 0,
      })
      .returning();

    if (input.choices?.length) {
      await this.replaceChoices(orgId, question.id, input.choices);
    }

    return this.getQuestion(orgId, question.id);
  }

  async getQuestion(orgId: string, questionId: number) {
    const question = await this.db.query.surveyQuestions.findFirst({
      where: and(eq(surveyQuestions.id, questionId), eq(surveyQuestions.orgId, orgId)),
      with: { choices: { orderBy: [asc(surveyQuestionChoices.sortOrder)] } },
    });
    if (!question) throw new NotFoundException("Question not found");
    return question;
  }

  async patchQuestion(orgId: string, surveyId: number, questionId: number, input: PatchQuestionInput) {
    const { choices, ...rest } = input;
    const [updated] = await this.db
      .update(surveyQuestions)
      .set({ ...rest, updatedAt: new Date() })
      .where(and(eq(surveyQuestions.id, questionId), eq(surveyQuestions.orgId, orgId), eq(surveyQuestions.surveyId, surveyId)))
      .returning();
    if (!updated) throw new NotFoundException("Question not found");

    if (choices) {
      await this.replaceChoices(orgId, questionId, choices);
    }

    return this.getQuestion(orgId, questionId);
  }

  async deleteQuestion(orgId: string, surveyId: number, questionId: number) {
    const [deleted] = await this.db
      .delete(surveyQuestions)
      .where(and(eq(surveyQuestions.id, questionId), eq(surveyQuestions.orgId, orgId), eq(surveyQuestions.surveyId, surveyId)))
      .returning();
    if (!deleted) throw new NotFoundException("Question not found");
    return { success: true };
  }

  async duplicateQuestion(orgId: string, surveyId: number, questionId: number) {
    const source = await this.getQuestion(orgId, questionId);
    if (source.surveyId !== surveyId) throw new NotFoundException("Question not found");

    const [cloned] = await this.db
      .insert(surveyQuestions)
      .values({
        orgId,
        surveyId: source.surveyId,
        versionId: source.versionId,
        sectionId: source.sectionId,
        questionKey: `q_${randomUUID().slice(0, 8)}`,
        variableName: source.variableName,
        type: source.type,
        title: `${source.title} (Copy)`,
        description: source.description,
        required: source.required,
        settings: source.settings,
        validation: source.validation,
        scoring: source.scoring,
        sortOrder: source.sortOrder + 1,
      })
      .returning();

    if (source.choices.length > 0) {
      await this.db.insert(surveyQuestionChoices).values(
        source.choices.map((choice) => ({
          orgId,
          questionId: cloned.id,
          choiceKey: choice.choiceKey,
          label: choice.label,
          value: choice.value,
          score: choice.score,
          sortOrder: choice.sortOrder,
          isCorrect: choice.isCorrect,
        })),
      );
    }

    return this.getQuestion(orgId, cloned.id);
  }

  async reorder(orgId: string, surveyId: number, input: ReorderInput) {
    await this.versions.assertSurveyInOrg(orgId, surveyId);
    await this.db.transaction(async (tx) => {
      // Last occurrence wins, which is what the per-row loop did. Collapsing here
      // is not cosmetic: bulkUpdateFromValues refuses a repeated key, because a
      // duplicate joins the target row twice and Postgres applies one arbitrary
      // row while silently discarding the rest.
      const sections = [...new Map((input.sections ?? []).map((s) => [s.id, s])).values()];
      const questions = [...new Map((input.questions ?? []).map((q) => [q.id, q])).values()];

      await bulkUpdateFromValues(tx, {
        table: surveySections,
        orgId,
        key: { column: "id", type: "integer" },
        columns: [{ column: "sort_order", type: "integer" }],
        rows: sections.map((section) => ({ key: section.id, values: [section.sortOrder] })),
        touch: ["updated_at"],
        extraWhere: eq(surveySections.surveyId, surveyId),
      });

      await bulkUpdateFromValues(tx, {
        table: surveyQuestions,
        orgId,
        key: { column: "id", type: "integer" },
        columns: [
          { column: "section_id", type: "integer" },
          { column: "sort_order", type: "integer" },
        ],
        rows: questions.map((question) => ({
          key: question.id,
          values: [question.sectionId, question.sortOrder],
        })),
        touch: ["updated_at"],
        extraWhere: eq(surveyQuestions.surveyId, surveyId),
      });
    });
    return { success: true };
  }

  private async replaceChoices(orgId: string, questionId: number, choices: CreateQuestionInput["choices"]) {
    await this.db.delete(surveyQuestionChoices).where(and(eq(surveyQuestionChoices.questionId, questionId), eq(surveyQuestionChoices.orgId, orgId)));
    const choiceList = choices ?? [];
    if (choiceList.length > 0) {
      await this.db.insert(surveyQuestionChoices).values(
        choiceList.map((choice, index) => ({
          orgId,
          questionId,
          choiceKey: choice.choiceKey,
          label: choice.label,
          value: choice.value ?? null,
          score: choice.score ?? 0,
          sortOrder: choice.sortOrder ?? index,
          isCorrect: choice.isCorrect ?? false,
        })),
      );
    }
  }
}
