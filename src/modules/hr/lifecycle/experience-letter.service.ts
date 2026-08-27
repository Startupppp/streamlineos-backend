import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import {
  hrEmployments,
  hrPeople,
  hrTemplates,
  organizationMembers,
  organizationPeople,
  richDocuments,
  users,
  workerEngagements,
  workers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { formatLongInIN } from "../../../common/date";
import { HrTemplateRenderService } from "../templates/hr-template-render.service";
import type { ExperienceLetterInput } from "./dto/hr-lifecycle.schemas";

@Injectable()
export class ExperienceLetterService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly templateRender: HrTemplateRenderService,
  ) {}

  async create(
    orgId: string,
    actorUserId: string,
    input: ExperienceLetterInput,
  ): Promise<{ documentId: number; title: string }> {
    const [employee] = await this.db
      .select({
        userFirstName: users.firstName,
        userLastName: users.lastName,
        userName: users.name,
        directoryFirstName: organizationPeople.firstName,
        directoryLastName: organizationPeople.lastName,
        workforceEmploymentId: workerEngagements.workerEngagementId,
        legacyEmploymentId: hrEmployments.id,
        workforceJoiningDate: workerEngagements.startsOn,
        legacyJoiningDate: hrEmployments.joiningDate,
        workforceDesignation: workerEngagements.designation,
        legacyDesignation: hrEmployments.designation,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(
        organizationPeople,
        and(
          eq(organizationPeople.organizationId, orgId),
          or(
            eq(organizationPeople.userId, input.userId),
            eq(
              organizationPeople.organizationMembershipId,
              organizationMembers.id,
            ),
          ),
          isNull(organizationPeople.deletedAt),
        ),
      )
      .leftJoin(
        workers,
        and(
          eq(workers.organizationId, orgId),
          eq(
            workers.organizationPersonId,
            organizationPeople.organizationPersonId,
          ),
          isNull(workers.deletedAt),
        ),
      )
      .leftJoin(
        workerEngagements,
        and(
          eq(workerEngagements.organizationId, orgId),
          eq(workerEngagements.workerId, workers.workerId),
          ne(workerEngagements.status, "CANCELLED"),
        ),
      )
      .leftJoin(
        hrPeople,
        and(
          eq(hrPeople.orgId, orgId),
          eq(hrPeople.userId, input.userId),
          isNull(hrPeople.deletedAt),
        ),
      )
      .leftJoin(
        hrEmployments,
        and(
          eq(hrEmployments.orgId, orgId),
          eq(hrEmployments.personId, hrPeople.id),
          eq(hrEmployments.isPrimary, true),
          isNull(hrEmployments.deletedAt),
        ),
      )
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, input.userId),
          ne(organizationMembers.status, "INVITED"),
          isNull(users.deletedAt),
        ),
      )
      .orderBy(
        desc(workerEngagements.isPrimary),
        desc(workerEngagements.startsOn),
      )
      .limit(1);

    if (!employee?.workforceEmploymentId && !employee?.legacyEmploymentId) {
      throw new NotFoundException("Organization employment record not found.");
    }

    const name =
      `${employee.directoryFirstName ?? employee.userFirstName ?? ""} ${employee.directoryLastName ?? employee.userLastName ?? ""}`.trim() ||
      employee.userName ||
      "Employee";
    const employmentJoiningDate =
      employee.workforceJoiningDate ?? employee.legacyJoiningDate;
    const joiningDate = employmentJoiningDate
      ? formatLongInIN(employmentJoiningDate)
      : "N/A";
    const designation =
      employee.workforceDesignation ??
      employee.legacyDesignation ??
      "a team member";
    const relievingDate = formatLongInIN(input.relievingDate);
    const contentJson = await this.renderContent(
      orgId,
      actorUserId,
      name,
      joiningDate,
      relievingDate,
      designation,
    );

    const [document] = await this.db
      .insert(richDocuments)
      .values({
        orgId,
        title: `Experience Certificate - ${name}`,
        contentJson,
        templateType: "experience_letter",
        isPublished: false,
        version: 1,
        createdBy: actorUserId,
      })
      .returning();

    return { documentId: document.id, title: document.title };
  }

  private async renderContent(
    orgId: string,
    actorUserId: string,
    name: string,
    joiningDate: string,
    relievingDate: string,
    designation: string,
  ): Promise<Record<string, unknown>> {
    const [template] = await this.db
      .select()
      .from(hrTemplates)
      .where(
        and(
          eq(hrTemplates.orgId, orgId),
          eq(hrTemplates.kind, "letter"),
          eq(hrTemplates.letterType, "experience"),
          eq(hrTemplates.status, "active"),
          isNull(hrTemplates.deletedAt),
        ),
      )
      .limit(1);

    if (template) {
      const bodyHtml = (template.content as { bodyHtml?: string }).bodyHtml ?? "";
      const context = await this.templateRender.buildContext(
        orgId,
        actorUserId,
        undefined,
        {
          "employee.fullName": name,
          "employee.joiningDate": joiningDate,
          "employee.designation": designation,
          "employee.relievingDate": relievingDate,
        },
        false,
      );
      return { html: this.templateRender.renderHtml(bodyHtml, context) };
    }

    return {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Experience Certificate" }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `Date: ${new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })}`,
            },
          ],
        },
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "To Whom It May Concern," }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `This is to certify that ${name} was employed with our organization from ${joiningDate} to ${relievingDate} as ${designation}.`,
            },
          ],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: `We wish ${name} all the best in their future endeavors.`,
            },
          ],
        },
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Sincerely," }],
        },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [{ type: "bold" }],
              text: "HR Department",
            },
          ],
        },
      ],
    };
  }
}
