import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  hrTemplateRenders,
  hrTemplates,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { RenderLetterInput, SaveLetterInput } from "./dto/documents.schemas";
import { z } from "zod";
import { liveEmployment, livePersonOfEmployment } from "../../directory/employment-query";

const letterTemplateContentSchema = z.object({
  bodyHtml: z.string().optional(),
  subject: z.string().optional(),
});

@Injectable()
export class LettersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async resolveEmploymentId(
    orgId: string,
    target: { employmentId?: number; employeeUserId?: string },
  ): Promise<number | null> {
    let employment: { employmentId: number } | undefined;
    if (target.employmentId) {
      [employment] = await this.db
        .select({ employmentId: hrEmployments.id })
        .from(hrEmployments)
        .where(
          and(
            eq(hrEmployments.orgId, orgId),
            eq(hrEmployments.id, target.employmentId),
            isNull(hrEmployments.deletedAt),
          ),
        )
        .limit(1);
    } else if (target.employeeUserId) {
      [employment] = await this.db
        .select({ employmentId: hrEmployments.id })
        .from(hrEmployments)
        .innerJoin(hrPeople, livePersonOfEmployment(orgId))
        .where(
          and(
            liveEmployment(orgId),
            eq(hrPeople.userId, target.employeeUserId),
          ),
        )
        .orderBy(desc(hrEmployments.isPrimary), desc(hrEmployments.createdAt))
        .limit(1);
    } else {
      return null;
    }

    if (!employment) throw new NotFoundException("Employee not found.");
    return employment.employmentId;
  }

  listLetters(orgId: string, employmentId?: string) {
    return this.db
      .select({
        id: hrTemplateRenders.id,
        templateId: hrTemplateRenders.templateId,
        templateVersion: hrTemplateRenders.templateVersion,
        renderedForEmploymentId: hrTemplateRenders.renderedForEmployeeId,
        renderedBy: hrTemplateRenders.renderedBy,
        createdAt: hrTemplateRenders.createdAt,
        templateName: hrTemplates.name,
        templateLetterType: hrTemplates.letterType,
        rendererName: users.name,
      })
      .from(hrTemplateRenders)
      .innerJoin(hrTemplates, eq(hrTemplateRenders.templateId, hrTemplates.id))
      .innerJoin(users, eq(hrTemplateRenders.renderedBy, users.id))
      .where(
        and(
          eq(hrTemplateRenders.orgId, orgId),
          employmentId
            ? eq(hrTemplateRenders.renderedForEmployeeId, parseInt(employmentId, 10))
            : undefined,
        ),
      )
      .orderBy(desc(hrTemplateRenders.createdAt))
      .limit(100);
  }

  async renderLetter(orgId: string, input: RenderLetterInput) {
    const template = await this.db.query.hrTemplates.findFirst({
      where: and(
        eq(hrTemplates.id, input.templateId),
        eq(hrTemplates.orgId, orgId),
        isNull(hrTemplates.deletedAt),
      ),
    });
    if (!template) throw new NotFoundException("Template not found.");

    const parsedContent = letterTemplateContentSchema.safeParse(template.content);
    const bodyHtml = parsedContent.success ? (parsedContent.data.bodyHtml ?? "") : "";
    const variables = template.variablesUsed ?? [];
    const context: Record<string, string> = { ...(input.extraContext ?? {}) };

    for (const variableName of variables) {
      if (!(variableName in context)) {
        context[variableName] = `{{${variableName}}}`;
      }
    }

    const outputHtml = bodyHtml.replace(
      /\{\{([^}]+)\}\}/g,
      (_, variableName: string) =>
        context[variableName.trim()] ?? `{{${variableName.trim()}}}`,
    );

    const employmentId = await this.resolveEmploymentId(orgId, input);

    return {
      templateId: template.id,
      templateVersion: template.version,
      templateName: template.name,
      letterType: template.letterType,
      outputHtml,
      variables,
      contextSnapshot: context,
      employmentId: employmentId ?? undefined,
    };
  }

  async saveLetter(orgId: string, userId: string, input: SaveLetterInput) {
    const template = await this.db.query.hrTemplates.findFirst({
      where: and(
        eq(hrTemplates.id, input.templateId),
        eq(hrTemplates.orgId, orgId),
        isNull(hrTemplates.deletedAt),
      ),
      columns: { id: true },
    });
    if (!template) throw new NotFoundException("Template not found.");

    const employmentId = await this.resolveEmploymentId(orgId, input);
    const [record] = await this.db
      .insert(hrTemplateRenders)
      .values({
        orgId,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        renderedForEmployeeId: employmentId,
        renderedBy: userId,
        contextSnapshot: input.contextSnapshot ?? {},
        outputHtml: input.outputHtml,
      })
      .returning();

    return record;
  }
}
