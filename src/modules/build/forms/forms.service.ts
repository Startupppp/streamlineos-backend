import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { projectForms } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess, assertProjectWriteAccess } from "../core";
import type { CreateFormInput, ListFormsQuery, UpdateFormInput } from "./dto/forms.schemas";
import { buildTupleCursorPage, decodeTupleCursor } from "../../../common/pagination/cursor";

type FormRow = typeof projectForms.$inferSelect;
type FormPatch = Partial<typeof projectForms.$inferInsert>;
const FORM_PAGE_SIZE = 100;

function decodeFormCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  const parts = decodeTupleCursor(cursor, 2);
  if (!parts) throw new BadRequestException("Invalid pagination cursor");
  const [createdAtValue, idValue] = parts;
  const id = Number(idValue);
  const createdAt = new Date(createdAtValue);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647 || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== createdAtValue) {
    throw new BadRequestException("Invalid pagination cursor");
  }
  return { createdAt, id };
}

@Injectable()
export class FormsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
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

  async listForms(u: CurrentUserContext, projectId: number, query: ListFormsQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const cursor = decodeFormCursor(query.cursor);
    const rows = await this.db
      .select({
        id: projectForms.id,
        orgId: projectForms.orgId,
        projectId: projectForms.projectId,
        formNumber: projectForms.formNumber,
        name: projectForms.name,
        description: projectForms.description,
        type: projectForms.type,
        fields: projectForms.fields,
        actions: projectForms.actions,
        isActive: projectForms.isActive,
        isPublic: projectForms.isPublic,
        publicToken: projectForms.publicToken,
        createdBy: projectForms.createdBy,
        createdAt: projectForms.createdAt,
        updatedAt: projectForms.updatedAt,
        deletedAt: projectForms.deletedAt,
      })
      .from(projectForms)
      .where(
        and(
          eq(projectForms.orgId, u.orgId),
          eq(projectForms.projectId, projectId),
          isNull(projectForms.deletedAt),
          query.type !== undefined ? eq(projectForms.type, query.type) : undefined,
          query.isActive !== undefined ? eq(projectForms.isActive, query.isActive) : undefined,
          query.q
            ? sql`to_tsvector('english', coalesce(${projectForms.name}, '') || ' ' || coalesce(${projectForms.description}, '')) @@ plainto_tsquery('english', ${query.q})`
            : undefined,
          cursor
            ? or(
                lt(projectForms.createdAt, cursor.createdAt),
                and(eq(projectForms.createdAt, cursor.createdAt), lt(projectForms.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(projectForms.createdAt), desc(projectForms.id))
      .limit(FORM_PAGE_SIZE + 1);
    return buildTupleCursorPage(rows, FORM_PAGE_SIZE, (row) => [
      row.createdAt.toISOString(),
      String(row.id),
    ]);
  }

  async getForm(u: CurrentUserContext, projectId: number, formId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.loadForm(u.orgId, projectId, formId);
  }

  async createForm(u: CurrentUserContext, projectId: number, input: CreateFormInput) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    const [form] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${projectForms.formNumber}), 0)` })
        .from(projectForms)
        .where(and(eq(projectForms.projectId, projectId), eq(projectForms.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      const isPublic = input.isPublic ?? false;
      return tx.insert(projectForms).values({
        orgId: u.orgId,
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
        createdBy: u.userId,
      }).returning();
    });
    if (!form) throw new NotFoundException("Failed to create form");
    this.audit.log({
      action: "form.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_form",
      resourceId: String(form.id),
      metadata: { projectId, formId: form.id, name: form.name },
    });
    return form;
  }

  async updateForm(u: CurrentUserContext, projectId: number, formId: number, input: UpdateFormInput) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    const existing = await this.loadForm(u.orgId, projectId, formId);
    if (
      input.version !== undefined &&
      new Date(input.version).getTime() !== existing.updatedAt.getTime()
    ) {
      throw new ConflictException("Form has been modified by another session");
    }
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
      .where(and(eq(projectForms.id, formId), eq(projectForms.orgId, u.orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Form not found");
    this.audit.log({
      action: "form.updated",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_form",
      resourceId: String(formId),
      metadata: { projectId, formId },
    });
    return updated;
  }

  async deleteForm(u: CurrentUserContext, projectId: number, formId: number) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    await this.loadForm(u.orgId, projectId, formId);
    await this.db
      .update(projectForms)
      .set({ deletedAt: new Date() })
      .where(and(eq(projectForms.id, formId), eq(projectForms.orgId, u.orgId)));
    this.audit.log({
      action: "form.deleted",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "project_form",
      resourceId: String(formId),
      metadata: { projectId, formId },
    });
  }
}
