import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { formSubmissions, projectForms, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import type { CreateSubmissionInput, ListSubmissionsQuery, UpdateSubmissionInput } from "./dto/forms.schemas";
import { allocateTicketNumbers } from "../core/lib/allocate-ticket-number";
import { reserveTicketCapacity } from "../core/build-ticket-capacity";

type FormRow = typeof projectForms.$inferSelect;
type SubmissionRow = typeof formSubmissions.$inferSelect;

type SubmissionRunResult = {
  submission: SubmissionRow;
  createdTicketIds: number[];
  executedActionTypes: string[];
  skippedActionTypes: string[];
};

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

  private async loadPublicForm(publicToken: string): Promise<FormRow> {
    const row = await withPublicToken(this.db, publicToken, (tx) =>
      tx.query.projectForms.findFirst({
        where: and(
          eq(projectForms.publicToken, publicToken),
          eq(projectForms.isPublic, true),
          isNull(projectForms.deletedAt),
        ),
      }),
    );
    if (!row) throw new NotFoundException("Form not found");
    if (!row.isActive) throw new BadRequestException("Form is not active");
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

  private async runSubmission(
    form: FormRow,
    input: CreateSubmissionInput,
    userId: string | null,
  ): Promise<SubmissionRunResult> {
    const { orgId, id: formId, projectId } = form;

    const executedActionTypes: string[] = [];
    const skippedActionTypes: string[] = [];
    const createdTicketIds: number[] = [];

    const ticketActions = form.actions.filter(
      (action) => action.type === "create_task" || action.type === "create_bug",
    );
    for (const action of form.actions)
      if (action.type !== "create_task" && action.type !== "create_bug")
        skippedActionTypes.push(action.type);

    const description = Object.entries(input.values)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join("\n");

    const [submission] = await this.db.transaction(async (tx) => {
      if (ticketActions.length > 0) {
        await reserveTicketCapacity(tx, orgId, projectId, [{ status: "TODO", count: ticketActions.length }]);
        const startNumber = await allocateTicketNumbers(tx, orgId, projectId, ticketActions.length);
        const inserted = await tx
          .insert(tickets)
          .values(
            ticketActions.map((action, index) => {
              const config = action.config ?? {};
              const titleFieldKey =
                typeof config["titleField"] === "string" ? config["titleField"] : undefined;
              const rawTitle = titleFieldKey !== undefined ? input.values[titleFieldKey] : undefined;
              return {
                orgId,
                projectId,
                ticketNumber: startNumber + index,
                title: typeof rawTitle === "string" ? rawTitle : form.name,
                description,
                type: action.type === "create_bug" ? ("BUG" as const) : ("TASK" as const),
                status: "TODO" as const,
                priority: "MEDIUM" as const,
                reporterId: userId,
              };
            }),
          )
          .returning({ id: tickets.id });

        for (const [index, ticket] of inserted.entries()) {
          createdTicketIds.push(ticket.id);
          const action = ticketActions[index];
          if (action) executedActionTypes.push(action.type);
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
    return { submission, createdTicketIds, executedActionTypes, skippedActionTypes };
  }

  async listSubmissions(orgId: string, projectId: number, formId: number, query: ListSubmissionsQuery) {
    await this.loadForm(orgId, projectId, formId);
    const cursorDate = query.cursor ? new Date(query.cursor) : undefined;
    return this.db
      .select({
        id: formSubmissions.id,
        orgId: formSubmissions.orgId,
        formId: formSubmissions.formId,
        projectId: formSubmissions.projectId,
        values: formSubmissions.values,
        status: formSubmissions.status,
        submittedByName: formSubmissions.submittedByName,
        submittedById: formSubmissions.submittedById,
        convertedTicketId: formSubmissions.convertedTicketId,
        createdAt: formSubmissions.createdAt,
      })
      .from(formSubmissions)
      .where(and(
        eq(formSubmissions.orgId, orgId),
        eq(formSubmissions.formId, formId),
        query.status ? eq(formSubmissions.status, query.status) : undefined,
        cursorDate ? lt(formSubmissions.createdAt, cursorDate) : undefined,
      ))
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

    const { submission, createdTicketIds, executedActionTypes, skippedActionTypes } =
      await this.runSubmission(form, input, userId);

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

  async submitPublicForm(publicToken: string, input: CreateSubmissionInput) {
    const form = await this.loadPublicForm(publicToken);

    const { submission, executedActionTypes, skippedActionTypes } =
      await this.runSubmission(form, input, null);

    this.audit.log({
      action: "form.public_submitted",
      systemActor: "public-form-submit",
      orgId: form.orgId,
      resourceType: "form_submission",
      resourceId: String(submission.id),
      metadata: { projectId: form.projectId, formId: form.id, submissionId: submission.id },
    });
    return {
      id: submission.id,
      status: submission.status,
      submittedByName: submission.submittedByName,
      values: submission.values,
      createdAt: submission.createdAt,
      executedActionTypes,
      skippedActionTypes,
    };
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
      .where(and(
        eq(formSubmissions.id, submissionId),
        eq(formSubmissions.orgId, orgId),
        eq(formSubmissions.formId, formId),
      ))
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
