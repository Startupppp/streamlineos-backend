import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { projectForms, projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CreateFormInput, ListFormsQuery, UpdateFormInput } from "./dto/forms.schemas";

type FormRow = typeof projectForms.$inferSelect;
type FormPatch = Partial<typeof projectForms.$inferInsert>;

@Injectable()
export class FormsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async assertProject(orgId: string, projectId: number): Promise<void> {
    const p = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!p) throw new NotFoundException("Project not found");
  }

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

  async listForms(orgId: string, projectId: number, query: ListFormsQuery) {
    await this.assertProject(orgId, projectId);
    return this.db
      .select()
      .from(projectForms)
      .where(
        and(
          eq(projectForms.orgId, orgId),
          eq(projectForms.projectId, projectId),
          isNull(projectForms.deletedAt),
          query.type !== undefined ? eq(projectForms.type, query.type) : undefined,
          query.isActive !== undefined ? eq(projectForms.isActive, query.isActive) : undefined,
        ),
      )
      .orderBy(desc(projectForms.createdAt))
      .limit(100);
  }

  async getForm(orgId: string, projectId: number, formId: number) {
    return this.loadForm(orgId, projectId, formId);
  }

  async createForm(orgId: string, userId: string, projectId: number, input: CreateFormInput) {
    await this.assertProject(orgId, projectId);
    const [form] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectForms.formNumber}), 0)` })
        .from(projectForms)
        .where(and(eq(projectForms.projectId, projectId), eq(projectForms.orgId, orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      const isPublic = input.isPublic ?? false;
      return tx.insert(projectForms).values({
        orgId,
        projectId,
        formNumber: nextNumber,
        name: input.name,
        description: input.description ?? null,
        type: input.type ?? "generic",
        fields: input.fields,
        actions: input.actions,
        isActive: input.isActive ?? true,
        isPublic,
        publicToken: isPublic ? randomBytes(24).toString("hex") : null,
        createdBy: userId,
      }).returning();
    });
    if (!form) throw new NotFoundException("Failed to create form");
    this.audit.log({
      action: "form.created",
      userId,
      orgId,
      resourceType: "project_form",
      resourceId: String(form.id),
      metadata: { projectId, formId: form.id, name: form.name },
    });
    return form;
  }

  async updateForm(orgId: string, userId: string, projectId: number, formId: number, input: UpdateFormInput) {
    const existing = await this.loadForm(orgId, projectId, formId);
    const patch: FormPatch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.type !== undefined) patch.type = input.type;
    if (input.fields !== undefined) patch.fields = input.fields;
    if (input.actions !== undefined) patch.actions = input.actions;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.isPublic !== undefined) {
      patch.isPublic = input.isPublic;
      if (input.isPublic && !existing.publicToken) {
        patch.publicToken = randomBytes(24).toString("hex");
      }
    }
    const [updated] = await this.db
      .update(projectForms)
      .set(patch)
      .where(and(eq(projectForms.id, formId), eq(projectForms.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Form not found");
    this.audit.log({
      action: "form.updated",
      userId,
      orgId,
      resourceType: "project_form",
      resourceId: String(formId),
      metadata: { projectId, formId },
    });
    return updated;
  }

  async deleteForm(orgId: string, userId: string, projectId: number, formId: number) {
    await this.loadForm(orgId, projectId, formId);
    await this.db
      .update(projectForms)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectForms.id, formId), eq(projectForms.orgId, orgId)));
    this.audit.log({
      action: "form.deleted",
      userId,
      orgId,
      resourceType: "project_form",
      resourceId: String(formId),
      metadata: { projectId, formId },
    });
  }
}
