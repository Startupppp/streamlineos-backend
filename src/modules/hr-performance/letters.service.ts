import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { hrTemplateRenders, hrTemplates, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { RenderLetterInput, SaveLetterInput } from "./dto/documents.schemas";

@Injectable()
export class LettersService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listLetters(orgId: string, employeeId?: string) {
    return this.db
      .select({
        id: hrTemplateRenders.id,
        templateId: hrTemplateRenders.templateId,
        templateVersion: hrTemplateRenders.templateVersion,
        renderedForEmployeeId: hrTemplateRenders.renderedForEmployeeId,
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
          employeeId
            ? eq(hrTemplateRenders.renderedForEmployeeId, parseInt(employeeId, 10))
            : undefined,
        ),
      )
      .orderBy(desc(hrTemplateRenders.createdAt))
      .limit(100);
  }

  async renderLetter(orgId: string, userId: string, input: RenderLetterInput) {
    const template = await this.db.query.hrTemplates.findFirst({
      where: and(
        eq(hrTemplates.id, input.templateId),
        eq(hrTemplates.orgId, orgId),
      ),
    });
    if (!template) throw new NotFoundException("Template not found.");

    const content = template.content as { bodyHtml?: string; subject?: string };
    const bodyHtml = content.bodyHtml ?? "";
    const variables = template.variablesUsed ?? [];
    const ctx: Record<string, string> = { ...((input.extraContext as Record<string, string>) ?? {}) };

    for (const v of variables) {
      if (!(v in ctx)) ctx[v] = `{{${v}}}`;
    }

    const outputHtml = bodyHtml.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => ctx[key.trim()] ?? `{{${key.trim()}}}`);

    return {
      templateId: template.id,
      templateVersion: template.version,
      templateName: template.name,
      letterType: template.letterType,
      outputHtml,
      variables,
      contextSnapshot: ctx,
      employeeId: input.employeeId,
    };
  }

  async saveLetter(orgId: string, userId: string, input: SaveLetterInput) {
    const template = await this.db.query.hrTemplates.findFirst({
      where: and(
        eq(hrTemplates.id, input.templateId),
        eq(hrTemplates.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!template) throw new NotFoundException("Template not found.");

    const [record] = await this.db
      .insert(hrTemplateRenders)
      .values({
        orgId,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        renderedForEmployeeId: input.employeeId ?? null,
        renderedBy: userId,
        contextSnapshot: (input.contextSnapshot as Record<string, unknown>) ?? {},
        outputHtml: input.outputHtml,
      })
      .returning();

    return record;
  }
}
