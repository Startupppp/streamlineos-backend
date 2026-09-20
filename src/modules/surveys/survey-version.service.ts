import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  surveyForms,
  surveyVersions,
  surveySections,
  surveyQuestions,
  surveyQuestionChoices,
  surveyLogicRules,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { assertSurveyInOrg } from "./survey-tenant";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function remapQuestionIds(node: unknown, idMap: Map<number, number>): unknown {
  if (Array.isArray(node)) return node.map((item) => remapQuestionIds(item, idMap));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "questionId" && typeof value === "number" && idMap.has(value)) {
        out[key] = idMap.get(value);
      } else {
        out[key] = remapQuestionIds(value, idMap);
      }
    }
    return out;
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function remapQuestionIdsInRecord(node: Record<string, unknown>, idMap: Map<number, number>): Record<string, unknown> {
  const remapped = remapQuestionIds(node, idMap);
  return isRecord(remapped) ? remapped : {};
}

@Injectable()
export class SurveyVersionService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async assertSurveyInOrg(orgId: string, surveyId: number) {
    await assertSurveyInOrg(this.db, orgId, surveyId);
  }

  async getDraftVersion(orgId: string, surveyId: number) {
    const existing = await this.db.query.surveyVersions.findFirst({
      where: and(eq(surveyVersions.orgId, orgId), eq(surveyVersions.surveyId, surveyId), isNull(surveyVersions.publishedAt)),
      orderBy: [desc(surveyVersions.versionNumber)],
    });
    if (existing) return existing;

    await this.assertSurveyInOrg(orgId, surveyId);

    const [created] = await runInNewTenantTransaction(this.db, orgId, (tx) =>
      tx.insert(surveyVersions).values({ orgId, surveyId, versionNumber: 1 }).returning(),
    );
    return created;
  }

  async buildSchemaSnapshot(orgId: string, versionId: number) {
    const sections = await this.db.query.surveySections.findMany({
      where: and(eq(surveySections.orgId, orgId), eq(surveySections.versionId, versionId)),
      orderBy: [asc(surveySections.sortOrder)],
    });
    const questions = await this.db.query.surveyQuestions.findMany({
      where: and(eq(surveyQuestions.orgId, orgId), eq(surveyQuestions.versionId, versionId)),
      orderBy: [asc(surveyQuestions.sortOrder)],
      with: { choices: { orderBy: [asc(surveyQuestionChoices.sortOrder)] } },
    });
    const logicRules = await this.db.query.surveyLogicRules.findMany({
      where: and(eq(surveyLogicRules.orgId, orgId), eq(surveyLogicRules.versionId, versionId)),
      orderBy: [asc(surveyLogicRules.sortOrder)],
    });

    return {
      sections: sections.map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description,
        sortOrder: section.sortOrder,
        settings: section.settings,
        questions: questions
          .filter((q) => q.sectionId === section.id)
          .map((q) => ({
            id: q.id,
            questionKey: q.questionKey,
            variableName: q.variableName,
            type: q.type,
            title: q.title,
            description: q.description,
            required: q.required,
            settings: q.settings,
            validation: q.validation,
            scoring: q.scoring,
            sortOrder: q.sortOrder,
            choices: q.choices.map((c) => ({
              id: c.id,
              choiceKey: c.choiceKey,
              label: c.label,
              value: c.value,
              score: c.score,
              sortOrder: c.sortOrder,
              isCorrect: c.isCorrect,
            })),
          })),
      })),
      logicRules: logicRules.map((rule) => ({
        id: rule.id,
        sourceQuestionId: rule.sourceQuestionId,
        condition: rule.condition,
        action: rule.action,
        target: rule.target,
        sortOrder: rule.sortOrder,
      })),
    };
  }

  async publishVersion(orgId: string, surveyId: number) {
    return this.db.transaction(async (tx) => {
      const draft = await tx.query.surveyVersions.findFirst({
        where: and(eq(surveyVersions.orgId, orgId), eq(surveyVersions.surveyId, surveyId), isNull(surveyVersions.publishedAt)),
        orderBy: [desc(surveyVersions.versionNumber)],
      });
      if (!draft) throw new Error("No draft version to publish");

      const snapshot = await this.buildSchemaSnapshot(orgId, draft.id);

      const [published] = await tx
        .update(surveyVersions)
        .set({ publishedAt: new Date(), schemaSnapshot: snapshot })
        .where(eq(surveyVersions.id, draft.id))
        .returning();

      await tx.update(surveyForms).set({ activeVersionId: published.id, status: "published" }).where(eq(surveyForms.id, surveyId));

      await this.cloneVersionStructure(tx, orgId, published.id, surveyId, published.versionNumber + 1);

      return published;
    });
  }

  async duplicateSurveyStructure(orgId: string, fromSurveyId: number, toSurveyId: number) {
    return this.db.transaction(async (tx) => {
      const sourceDraft = await tx.query.surveyVersions.findFirst({
        where: and(eq(surveyVersions.orgId, orgId), eq(surveyVersions.surveyId, fromSurveyId)),
        orderBy: [desc(surveyVersions.versionNumber)],
      });
      if (!sourceDraft) throw new Error("Source survey has no version to duplicate");

      await tx.delete(surveyVersions).where(and(eq(surveyVersions.orgId, orgId), eq(surveyVersions.surveyId, toSurveyId)));

      return this.cloneVersionStructure(tx, orgId, sourceDraft.id, toSurveyId, 1);
    });
  }

  async cloneVersionStructure(tx: Tx, orgId: string, fromVersionId: number, surveyId: number, newVersionNumber: number) {
    const [newVersion] = await tx
      .insert(surveyVersions)
      .values({ orgId, surveyId, versionNumber: newVersionNumber })
      .returning();

    const sourceSections = await tx.query.surveySections.findMany({
      where: and(eq(surveySections.orgId, orgId), eq(surveySections.versionId, fromVersionId)),
      orderBy: [asc(surveySections.sortOrder)],
    });
    const sectionIdMap = new Map<number, number>();
    if (sourceSections.length > 0) {
      const clonedSections = await tx
        .insert(surveySections)
        .values(
          sourceSections.map((section) => ({
            orgId,
            surveyId,
            versionId: newVersion.id,
            title: section.title,
            description: section.description,
            sortOrder: section.sortOrder,
            settings: section.settings,
          })),
        )
        .returning();
      for (let i = 0; i < sourceSections.length; i++) {
        const src = sourceSections[i];
        const dst = clonedSections[i];
        if (src && dst) sectionIdMap.set(src.id, dst.id);
      }
    }

    const sourceQuestions = await tx.query.surveyQuestions.findMany({
      where: and(eq(surveyQuestions.orgId, orgId), eq(surveyQuestions.versionId, fromVersionId)),
      orderBy: [asc(surveyQuestions.sortOrder)],
      with: { choices: { orderBy: [asc(surveyQuestionChoices.sortOrder)] } },
    });
    const questionIdMap = new Map<number, number>();
    if (sourceQuestions.length > 0) {
      const clonedQuestions = await tx
        .insert(surveyQuestions)
        .values(
          sourceQuestions.map((question) => ({
            orgId,
            surveyId,
            versionId: newVersion.id,
            sectionId: sectionIdMap.get(question.sectionId) ?? question.sectionId,
            questionKey: question.questionKey,
            variableName: question.variableName,
            type: question.type,
            title: question.title,
            description: question.description,
            required: question.required,
            settings: question.settings,
            validation: question.validation,
            scoring: question.scoring,
            sortOrder: question.sortOrder,
          })),
        )
        .returning();
      for (let i = 0; i < sourceQuestions.length; i++) {
        const src = sourceQuestions[i];
        const dst = clonedQuestions[i];
        if (src && dst) questionIdMap.set(src.id, dst.id);
      }
      const allChoices = clonedQuestions.flatMap((cloned, qi) => {
        const choices = sourceQuestions[qi]?.choices ?? [];
        return choices.map((choice) => ({
          orgId,
          questionId: cloned.id,
          choiceKey: choice.choiceKey,
          label: choice.label,
          value: choice.value,
          score: choice.score,
          sortOrder: choice.sortOrder,
          isCorrect: choice.isCorrect,
        }));
      });
      if (allChoices.length > 0) {
        await tx.insert(surveyQuestionChoices).values(allChoices);
      }
    }

    const sourceLogicRules = await tx.query.surveyLogicRules.findMany({
      where: and(eq(surveyLogicRules.orgId, orgId), eq(surveyLogicRules.versionId, fromVersionId)),
      orderBy: [asc(surveyLogicRules.sortOrder)],
    });
    if (sourceLogicRules.length > 0) {
      await tx.insert(surveyLogicRules).values(
        sourceLogicRules.map((rule) => ({
          orgId,
          surveyId,
          versionId: newVersion.id,
          sourceQuestionId: questionIdMap.get(rule.sourceQuestionId) ?? rule.sourceQuestionId,
          condition: remapQuestionIdsInRecord(rule.condition, questionIdMap),
          action: remapQuestionIdsInRecord(rule.action, questionIdMap),
          target: rule.target ? remapQuestionIdsInRecord(rule.target, questionIdMap) : null,
          sortOrder: rule.sortOrder,
        })),
      );
    }

    return newVersion;
  }
}
