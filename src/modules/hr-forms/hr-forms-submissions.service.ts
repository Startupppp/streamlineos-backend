import { z } from "zod";
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrFormSubmissions } from "../../db/schema/hr/forms";
import { hrWorkflowObjectTypeEnum } from "../../db/schema/hr/workflow-engine";
import { HrAuditService } from "../hr-core/hr-audit.service";
import { HrWorkflowEngineService } from "../hr-workflows/hr-workflow-engine.service";
import { HrFormsService } from "./hr-forms.service";
import type {
  ListSubmissionsQuery,
  SubmitHrFormInput,
  UpdateSubmissionStatusInput,
} from "./dto/hr-forms.schemas";
import type { HrFormField } from "../../db/schema/hr/forms";

@Injectable()
export class HrFormsSubmissionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly formsService: HrFormsService,
    private readonly audit: HrAuditService,
    private readonly workflowEngine: HrWorkflowEngineService,
  ) {}

  private buildZodValidator(fields: HrFormField[]) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const field of fields) {
      let schema: z.ZodTypeAny;
      switch (field.type) {
        case "number":
        case "currency":
          schema = z.number();
          if (field.validation?.min !== undefined) schema = (schema as z.ZodNumber).min(field.validation.min);
          if (field.validation?.max !== undefined) schema = (schema as z.ZodNumber).max(field.validation.max);
          break;
        case "boolean":
          schema = z.boolean();
          break;
        case "date":
          schema = z.string().refine((v) => !isNaN(Date.parse(v)), "Invalid date");
          break;
        case "select":
          schema = field.options?.length
            ? z.enum(field.options.map((o) => o.value) as [string, ...string[]])
            : z.string();
          break;
        case "multi_select":
          schema = z.array(z.string());
          break;
        case "employee_ref":
        case "department_ref":
          schema = z.number().int().positive();
          break;
        default:
          schema = z.string();
          if (field.validation?.min !== undefined) schema = (schema as z.ZodString).min(field.validation.min);
          if (field.validation?.max !== undefined) schema = (schema as z.ZodString).max(field.validation.max);
          if (field.validation?.pattern !== undefined) {
            schema = (schema as z.ZodString).regex(new RegExp(field.validation.pattern));
          }
      }
      if (!field.required) {
        shape[field.key] = schema.optional();
      } else {
        shape[field.key] = schema;
      }
    }
    return z.object(shape);
  }

  private evaluateConditional(field: HrFormField, data: Record<string, unknown>): boolean {
    if (!field.conditional) return true;
    const { fieldKey, operator, value } = field.conditional;
    const dataValue = data[fieldKey];
    switch (operator) {
      case "eq": return dataValue === value;
      case "neq": return dataValue !== value;
      case "contains":
        return typeof dataValue === "string" && typeof value === "string" && dataValue.includes(value);
      case "notEmpty":
        return dataValue !== null && dataValue !== undefined && dataValue !== "";
      default: return true;
    }
  }

  async submit(
    orgId: string,
    formId: number,
    input: SubmitHrFormInput,
    submittedByUserId: string | null,
    canViewSensitive: boolean,
  ) {
    const form = await this.formsService.loadForm(orgId, formId);
    if (form.status !== "active") {
      throw new BadRequestException("Form is not active");
    }

    const visibleFields = form.schema.filter((f) => this.evaluateConditional(f, input.data));
    const requiredFields = visibleFields.filter((f) => f.required);

    const validator = this.buildZodValidator(requiredFields);
    const parseResult = validator.safeParse(input.data);
    if (!parseResult.success) {
      throw new BadRequestException(parseResult.error.issues.map((issue) => issue.message).join("; "));
    }

    const hasSensitive = visibleFields.some((f) => f.sensitive);
    if (hasSensitive && !canViewSensitive && form.audience !== "public") {
      throw new ForbiddenException("Sensitive fields require hr:sensitive:manage permission");
    }

    const [submission] = await this.db.transaction(async (tx) => {
      const [sub] = await tx
        .insert(hrFormSubmissions)
        .values({
          orgId,
          formId,
          formSchemaSnapshot: form.schema,
          submittedBy: submittedByUserId,
          submittedByName: input.submittedByName ?? null,
          subjectEmployeeId: input.subjectEmployeeId ?? null,
          data: input.data,
          status: "submitted",
        })
        .returning();

      if (!sub) throw new BadRequestException("Failed to create submission");

      const validWorkflowTypes = new Set<string>(hrWorkflowObjectTypeEnum.enumValues);
      if (form.workflowObjectType && submittedByUserId && validWorkflowTypes.has(form.workflowObjectType)) {
        try {
          await this.workflowEngine.startWorkflow({
            orgId,
            objectType: form.workflowObjectType as typeof hrWorkflowObjectTypeEnum.enumValues[number],
            objectId: String(sub.id),
            requestedByUserId: submittedByUserId,
            subjectEmployeeId: input.subjectEmployeeId ? String(input.subjectEmployeeId) : submittedByUserId,
            context: { formId, submissionId: sub.id },
            tx,
          });
        } catch {
          // workflow start is best-effort; submission is still recorded
        }
      }

      return [sub];
    });

    await this.audit.log({
      orgId,
      actorId: submittedByUserId,
      entityType: "hr_form_submission",
      entityId: String(submission.id),
      action: "form.submitted",
      after: { formId, formName: form.name },
    });

    return submission;
  }

  async listSubmissions(orgId: string, formId: number, query: ListSubmissionsQuery, canViewSensitive: boolean) {
    await this.formsService.loadForm(orgId, formId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrFormSubmissions.orgId, orgId), eq(hrFormSubmissions.formId, formId)];
    if (query.status) conditions.push(eq(hrFormSubmissions.status, query.status));
    const where = and(...conditions);

    const [rows, [total]] = await Promise.all([
      this.db.select().from(hrFormSubmissions).where(where).orderBy(desc(hrFormSubmissions.createdAt)).limit(limit).offset(offset),
      this.db.select({ count: count() }).from(hrFormSubmissions).where(where),
    ]);

    if (!canViewSensitive) {
      return {
        data: rows.map((r) => this.maskSensitiveData(r)),
        total: total?.count ?? 0,
        page,
        limit,
      };
    }

    return { data: rows, total: total?.count ?? 0, page, limit };
  }

  async getMySubmissions(orgId: string, userId: string) {
    return this.db
      .select()
      .from(hrFormSubmissions)
      .where(and(eq(hrFormSubmissions.orgId, orgId), eq(hrFormSubmissions.submittedBy, userId)))
      .orderBy(desc(hrFormSubmissions.createdAt))
      .limit(50);
  }

  async updateSubmissionStatus(
    orgId: string,
    submissionId: number,
    input: UpdateSubmissionStatusInput,
    actorId: string,
  ) {
    const [sub] = await this.db
      .select()
      .from(hrFormSubmissions)
      .where(and(eq(hrFormSubmissions.id, submissionId), eq(hrFormSubmissions.orgId, orgId)))
      .limit(1);
    if (!sub) throw new NotFoundException("Submission not found");

    const [updated] = await this.db
      .update(hrFormSubmissions)
      .set({ status: input.status })
      .where(and(eq(hrFormSubmissions.id, submissionId), eq(hrFormSubmissions.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Submission not found");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_form_submission",
      entityId: String(submissionId),
      action: "form.submission_status_updated",
      before: { status: sub.status },
      after: { status: input.status },
    });

    return updated;
  }

  private maskSensitiveData(sub: typeof hrFormSubmissions.$inferSelect) {
    const sensitiveKeys = new Set(
      sub.formSchemaSnapshot.filter((f) => f.sensitive).map((f) => f.key),
    );
    if (sensitiveKeys.size === 0) return sub;
    const maskedData = { ...sub.data };
    for (const key of sensitiveKeys) {
      if (key in maskedData) maskedData[key] = "[REDACTED]";
    }
    return { ...sub, data: maskedData };
  }
}
