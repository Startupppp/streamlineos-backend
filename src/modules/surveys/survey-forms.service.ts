import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { surveyForms, surveySections, surveyQuestions, surveyQuestionChoices } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SurveyVersionService } from "./survey-version.service";
import { SurveyTemplateService } from "./survey-template.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { CreateSurveyInput, ListSurveysInput, PatchSurveyInput } from "./dto/survey-forms.schemas";

@Injectable()
export class SurveyFormsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly versions: SurveyVersionService,
    private readonly templates: SurveyTemplateService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async list(orgId: string, filters: ListSurveysInput) {
    const conditions = [eq(surveyForms.orgId, orgId)];
    if (filters.status) conditions.push(eq(surveyForms.status, filters.status));
    if (filters.mode) conditions.push(eq(surveyForms.mode, filters.mode));
    if (filters.search) {
      conditions.push(or(ilike(surveyForms.title, `%${filters.search}%`), ilike(surveyForms.description, `%${filters.search}%`))!);
    }

    const rows = await this.db.query.surveyForms.findMany({
      where: and(...conditions),
      orderBy: [desc(surveyForms.createdAt)],
      limit: filters.pageSize,
      offset: (filters.page - 1) * filters.pageSize,
    });
    return rows;
  }

  async get(orgId: string, surveyId: number) {
    const survey = await this.db.query.surveyForms.findFirst({
      where: and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)),
    });
    if (!survey) throw new NotFoundException("Survey not found");
    return survey;
  }

  async create(orgId: string, userId: string, input: CreateSurveyInput) {
    await this.planLimits.assertWithinLimit(orgId, "surveys");

    const [survey] = await this.db
      .insert(surveyForms)
      .values({
        orgId,
        title: input.title,
        description: input.description ?? null,
        mode: input.mode,
        defaultLanguage: input.defaultLanguage,
        ownerUserId: userId,
        createdBy: userId,
      })
      .returning();

    const draftVersion = await this.versions.getDraftVersion(orgId, survey.id);
    const template = input.templateKey ? this.templates.get(input.templateKey) : undefined;
    const sections = template?.sections?.length ? template.sections : [{ title: "Section 1", questions: [] }];

    for (const [sectionIndex, section] of sections.entries()) {
      const [sectionRow] = await this.db
        .insert(surveySections)
        .values({ orgId, surveyId: survey.id, versionId: draftVersion.id, title: section.title, sortOrder: sectionIndex })
        .returning();

      for (const [questionIndex, question] of section.questions.entries()) {
        const [questionRow] = await this.db
          .insert(surveyQuestions)
          .values({
            orgId,
            surveyId: survey.id,
            versionId: draftVersion.id,
            sectionId: sectionRow.id,
            questionKey: `q_${survey.id}_${sectionIndex}_${questionIndex}`,
            type: question.type as (typeof surveyQuestions.$inferInsert)["type"],
            title: question.title,
            required: question.required ?? false,
            variableName: question.variableName ?? null,
            settings: question.settings ?? {},
            sortOrder: questionIndex,
          })
          .returning();

        for (const [choiceIndex, choice] of (question.choices ?? []).entries()) {
          await this.db.insert(surveyQuestionChoices).values({
            orgId,
            questionId: questionRow.id,
            choiceKey: choice.choiceKey,
            label: choice.label,
            value: choice.value ?? null,
            score: choice.score ?? 0,
            sortOrder: choiceIndex,
            isCorrect: choice.isCorrect ?? false,
          });
        }
      }
    }

    return survey;
  }

  async patch(orgId: string, surveyId: number, input: PatchSurveyInput) {
    await this.get(orgId, surveyId);
    const [updated] = await this.db
      .update(surveyForms)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
      .returning();
    return updated;
  }

  async publish(orgId: string, surveyId: number) {
    await this.get(orgId, surveyId);
    return this.versions.publishVersion(orgId, surveyId);
  }

  async pause(orgId: string, surveyId: number) {
    await this.get(orgId, surveyId);
    const [updated] = await this.db
      .update(surveyForms)
      .set({ status: "paused", updatedAt: new Date() })
      .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
      .returning();
    return updated;
  }

  async close(orgId: string, surveyId: number) {
    await this.get(orgId, surveyId);
    const [updated] = await this.db
      .update(surveyForms)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
      .returning();
    return updated;
  }

  async archive(orgId: string, surveyId: number) {
    await this.get(orgId, surveyId);
    const [updated] = await this.db
      .update(surveyForms)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
      .returning();
    return updated;
  }

  async duplicate(orgId: string, surveyId: number, userId: string) {
    await this.planLimits.assertWithinLimit(orgId, "surveys");

    const source = await this.get(orgId, surveyId);

    const [copy] = await this.db
      .insert(surveyForms)
      .values({
        orgId,
        title: `${source.title} (Copy)`,
        description: source.description,
        mode: source.mode,
        defaultLanguage: source.defaultLanguage,
        settings: source.settings,
        branding: source.branding,
        ownerUserId: userId,
        createdBy: userId,
      })
      .returning();

    await this.versions.getDraftVersion(orgId, copy.id);
    await this.versions.duplicateSurveyStructure(orgId, surveyId, copy.id);

    return copy;
  }
}
