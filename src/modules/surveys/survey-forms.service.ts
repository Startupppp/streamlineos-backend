import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { DataScope } from "../access/access.types";
import { applyScope } from "../access/apply-scope";
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

  /**
   * `surveys:view` is declared `scopable: true` and nothing applied the scope.
   *
   * So an administrator could grant somebody `own`, the product accepted it,
   * stored it and showed it back on the access screen — and every survey in the
   * organisation came back anyway. The inverse of an unreachable capability: a
   * requirement that exists and nothing satisfies.
   *
   * A survey with NO creator is excluded at `own`, because `eq(createdBy, ...)`
   * does not match NULL. There is no sibling aggregate here to copy the rule
   * from, so this is a choice: deny by default, matching the labour records
   * rather than the ASN list. Rows predating `created_by` become invisible to a
   * narrowed caller and stay visible to everyone at `all`, which is the safe
   * direction to be wrong in.
   *
   * Safe to turn on: `role_permission_grants.scope` defaults to `"all"` and no
   * role template mentions surveys, so every grant that exists today is `all`
   * and nothing moves for anyone who has not deliberately narrowed.
   */
  async list(orgId: string, userId: string, filters: ListSurveysInput, scope: DataScope) {
    const conditions = [
      eq(surveyForms.orgId, orgId),
      applyScope(scope, orgId, userId, { ownerColumn: surveyForms.createdBy }),
    ];
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

  /**
   * The existence guard for `patch`, `publish`, `pause` and `close` as well as
   * the detail read — all four call this first — so scoping it scopes them.
   *
   * Out of scope answers "Survey not found", the same as a missing one, so this
   * does not become an oracle for which surveys exist.
   */
  async get(orgId: string, userId: string, surveyId: number, scope: DataScope) {
    const survey = await this.db.query.surveyForms.findFirst({
      where: and(
        eq(surveyForms.id, surveyId),
        eq(surveyForms.orgId, orgId),
        applyScope(scope, orgId, userId, { ownerColumn: surveyForms.createdBy }),
      ),
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

  async patch(orgId: string, userId: string, surveyId: number, input: PatchSurveyInput, scope: DataScope) {
    await this.get(orgId, userId, surveyId, scope);
    const [updated] = await this.db
      .update(surveyForms)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
      .returning();
    return updated;
  }

  async publish(orgId: string, userId: string, surveyId: number, scope: DataScope) {
    await this.get(orgId, userId, surveyId, scope);
    return this.versions.publishVersion(orgId, surveyId);
  }

  async pause(orgId: string, userId: string, surveyId: number, scope: DataScope) {
    await this.get(orgId, userId, surveyId, scope);
    const [updated] = await this.db
      .update(surveyForms)
      .set({ status: "paused", updatedAt: new Date() })
      .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
      .returning();
    return updated;
  }

  async close(orgId: string, userId: string, surveyId: number, scope: DataScope) {
    await this.get(orgId, userId, surveyId, scope);
    const [updated] = await this.db
      .update(surveyForms)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
      .returning();
    return updated;
  }

  async archive(orgId: string, userId: string, surveyId: number, scope: DataScope) {
    await this.get(orgId, userId, surveyId, scope);
    const [updated] = await this.db
      .update(surveyForms)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(surveyForms.id, surveyId), eq(surveyForms.orgId, orgId)))
      .returning();
    return updated;
  }

  async duplicate(orgId: string, surveyId: number, userId: string, scope: DataScope) {
    await this.planLimits.assertWithinLimit(orgId, "surveys");

    const source = await this.get(orgId, userId, surveyId, scope);

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
