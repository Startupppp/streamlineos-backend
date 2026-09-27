import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  hrReportingLines,
  hrTemplateRenders,
  hrTemplates,
  organizations,
  orgUnits,
  users,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { RenderLetterInput, SaveLetterInput } from "./dto/documents.schemas";
import { mergeLetterTemplate } from "./letter-merge";
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
    const employmentId = await this.resolveEmploymentId(orgId, input);
    const context: Record<string, string> = {
      ...(await this.letterFacts(orgId, employmentId)),
      ...(input.extraContext ?? {}),
    };

    const outputHtml = mergeLetterTemplate(bodyHtml, context);

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
    if (/\{\{[^}]+\}\}/.test(input.outputHtml)) {
      throw new BadRequestException("Fix the letter preview before saving. Some fields are still blank tokens.");
    }
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
    if (employmentId == null) {
      throw new BadRequestException("Select an employee before saving a letter.");
    }
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
      .returning({ id: hrTemplateRenders.id });

    const [row] = await this.db
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
      .where(and(eq(hrTemplateRenders.orgId, orgId), eq(hrTemplateRenders.id, record.id)))
      .limit(1);
    if (!row) throw new NotFoundException("Saved letter could not be read back.");
    return row;
  }

  private async letterFacts(orgId: string, employmentId: number | null): Promise<Record<string, string>> {
    const today = new Date().toLocaleDateString("en-IN", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    const [org] = await this.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    const facts: Record<string, string> = {
      today,
      "company.name": org?.name ?? "",
      "employee.fullName": "",
      "employee.firstName": "",
      "employee.lastName": "",
      "role.title": "",
      "department.name": "",
      "manager.fullName": "",
    };
    if (employmentId == null) return facts;

    const [person] = await this.db
      .select({
        name: users.name,
        designation: hrEmployments.designation,
        department: orgUnits.name,
      })
      .from(hrEmployments)
      .innerJoin(hrPeople, and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, hrEmployments.personId)))
      .leftJoin(users, eq(users.id, hrPeople.userId))
      .leftJoin(orgUnits, and(eq(orgUnits.orgId, orgId), eq(orgUnits.id, hrEmployments.departmentId)))
      .where(and(eq(hrEmployments.orgId, orgId), eq(hrEmployments.id, employmentId)))
      .limit(1);
    const fullName = person?.name?.trim() ?? "";
    const [firstName, ...rest] = fullName.split(/\s+/).filter(Boolean);
    facts["employee.fullName"] = fullName;
    facts["employee.firstName"] = firstName ?? "";
    facts["employee.lastName"] = rest.join(" ");
    facts["role.title"] = person?.designation?.trim() ?? "";
    facts["department.name"] = person?.department?.trim() ?? "";

    const [manager] = await this.db
      .select({ name: users.name })
      .from(hrReportingLines)
      .innerJoin(
        hrEmployments,
        and(eq(hrEmployments.orgId, orgId), eq(hrEmployments.id, hrReportingLines.managerEmploymentId)),
      )
      .innerJoin(hrPeople, and(eq(hrPeople.orgId, orgId), eq(hrPeople.id, hrEmployments.personId)))
      .leftJoin(users, eq(users.id, hrPeople.userId))
      .where(
        and(
          eq(hrReportingLines.orgId, orgId),
          eq(hrReportingLines.employmentId, employmentId),
          eq(hrReportingLines.lineType, "primary"),
          sql`${hrReportingLines.effectiveTo} = 'infinity'::date`,
        ),
      )
      .limit(1);
    facts["manager.fullName"] = manager?.name?.trim() ?? "";
    return facts;
  }
}
