import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { formSubmissions, projectForms, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CreateSubmissionInput, UpdateSubmissionInput } from "./dto/forms.schemas";
import { allocateTicketNumbers } from "../core/lib/allocate-ticket-number";

type FormRow = typeof projectForms.$inferSelect;
type SubmissionRow = typeof formSubmissions.$inferSelect;

@Injectable()
export class SubmissionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async loadForm(orgId: string, projectId: number, formId: number): Promise<FormRow> {
    const row = await this.db.query.projectForms.findFirst({
      where: and(
        eq(projectForms.id, formId),
        eq(projectForms.orgId, orgId),
        eq(projectForms.projectId, projectId),
        isNull(projectForms.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Form not found");
    return row;
  }

  private async loadSubmission(orgId: string, formId: number, submissionId: number): Promise<SubmissionRow> {
    const row = await this.db.query.formSubmissions.findFirst({
      where: and(
        eq(formSubmissions.id, submissionId),
        eq(formSubmissions.orgId, orgId),
        eq(formSubmissions.formId, formId),
      ),
    });
    if (!row) throw new NotFoundException("Submission not found");
    return row;
  }

  async listSubmissions(orgId: string, projectId: number, formId: number) {
    await this.loadForm(orgId, projectId, formId);
    return this.db
      .select()
      .from(formSubmissions)
      .where(and(eq(formSubmissions.orgId, orgId), eq(formSubmissions.formId, formId)))
      .orderBy(desc(formSubmissions.createdAt))
      .limit(100);
  }

  async createSubmission(
    orgId: string,
    userId: string,
    projectId: number,
    formId: number,
    input: CreateSubmissionInput,
  ) {
    const form = await this.loadForm(orgId, projectId, formId);
    if (!form.isActive) throw new BadRequestException("Form is not active");

    const executedActionTypes: string[] = [];
    const skippedActionTypes: string[] = [];
    const createdTicketIds: number[] = [];

    const [submission] = await this.db.transaction(async (tx) => {
      for (const action of form.actions) {
        if (action.type !== "create_task" && action.type !== "create_bug") {
          skippedActionTypes.push(action.type);
          continue;
        }
        const nextNumber = await allocateTicketNumbers(tx, orgId, projectId);
        const config = action.config ?? {};
        const titleFieldKey = typeof config["titleField"] === "string" ? config["titleField"] : undefined;
        const rawTitle = titleFieldKey !== undefined ? input.values[titleFieldKey] : undefined;
        const ticketTitle = typeof rawTitle === "string" ? rawTitle : form.name;
        const description = Object.entries(input.values)
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join("\n");
        const ticketType: "TASK" | "BUG" = action.type === "create_bug" ? "BUG" : "TASK";
        const [ticket] = await tx
          .insert(tickets)
          .values({
            orgId,
            projectId,
            ticketNumber: nextNumber,
            title: ticketTitle,
            description,
            type: ticketType,
            status: "TODO",
            priority: "MEDIUM",
            reporterId: userId,
          })
          .returning({ id: tickets.id });
        if (ticket) {
          createdTicketIds.push(ticket.id);
          executedActionTypes.push(action.type);
        }
      }

      const finalStatus = createdTicketIds.length > 0 ? "processed" : "submitted";
      const firstTicketId = createdTicketIds[0] ?? null;

      return tx.insert(formSubmissions).values({
        orgId,
        formId,
        projectId,
        values: input.values,
        status: finalStatus,
        submittedByName: input.submittedByName ?? null,
        submittedById: userId,
        convertedTicketId: firstTicketId,
      }).returning();
    });

    if (!submission) throw new NotFoundException("Failed to create submission");
    this.audit.log({
      action: "form.submitted",
      userId,
      orgId,
      resourceType: "form_submission",
      resourceId: String(submission.id),
      metadata: { projectId, formId, submissionId: submission.id, createdTicketIds },
    });
    return { ...submission, createdTicketIds, executedActionTypes, skippedActionTypes };
  }

  async updateSubmission(
    orgId: string,
    userId: string,
    projectId: number,
    formId: number,
    submissionId: number,
    input: UpdateSubmissionInput,
  ) {
    await this.loadForm(orgId, projectId, formId);
    await this.loadSubmission(orgId, formId, submissionId);
    const [updated] = await this.db
      .update(formSubmissions)
      .set({ status: input.status })
      .where(and(eq(formSubmissions.id, submissionId), eq(formSubmissions.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Submission not found");
    this.audit.log({
      action: "form.submission_updated",
      userId,
      orgId,
      resourceType: "form_submission",
      resourceId: String(submissionId),
      metadata: { projectId, formId, submissionId, status: input.status },
    });
    return updated;
  }
}
