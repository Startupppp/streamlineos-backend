import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrForms } from "../../db/schema/hr/forms";
import type {
  CreateHrFormInput,
  ListHrFormsQuery,
  UpdateHrFormInput,
} from "./dto/hr-forms.schemas";

type FormRow = typeof hrForms.$inferSelect;

@Injectable()
export class HrFormsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async loadForm(orgId: string, formId: number): Promise<FormRow> {
    const [row] = await this.db
      .select()
      .from(hrForms)
      .where(and(eq(hrForms.id, formId), eq(hrForms.orgId, orgId), isNull(hrForms.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("Form not found");
    return row;
  }

  async listForms(orgId: string, query: ListHrFormsQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrForms.orgId, orgId), isNull(hrForms.deletedAt)];
    if (query.status) conditions.push(eq(hrForms.status, query.status));
    if (query.audience) conditions.push(eq(hrForms.audience, query.audience));
    const where = and(...conditions);

    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(hrForms)
        .where(where)
        .orderBy(desc(hrForms.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ count: count() }).from(hrForms).where(where),
    ]);

    return { data: rows, total: total?.count ?? 0, page, limit };
  }

  async getForm(orgId: string, formId: number) {
    return this.loadForm(orgId, formId);
  }

  async createForm(orgId: string, userId: string, input: CreateHrFormInput) {
    const hasSensitiveOnPublic =
      input.audience === "public" && input.schema.some((f) => f.sensitive);
    if (hasSensitiveOnPublic) {
      throw new BadRequestException("Public forms cannot contain sensitive fields");
    }

    const [row] = await this.db
      .insert(hrForms)
      .values({
        orgId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        status: "draft",
        audience: input.audience,
        workflowObjectType: input.workflowObjectType ?? null,
        schema: input.schema,
        createdBy: userId,
      })
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === "23505") throw new ConflictException("Form name or slug already exists");
        throw err;
      });
    if (!row) throw new BadRequestException("Failed to create form");
    return row;
  }

  async updateForm(orgId: string, formId: number, input: UpdateHrFormInput) {
    const existing = await this.loadForm(orgId, formId);
    if (existing.status === "archived") {
      throw new BadRequestException("Archived forms cannot be updated");
    }

    const newAudience = input.audience ?? existing.audience;
    const newSchema = input.schema ?? existing.schema;
    if (newAudience === "public" && newSchema.some((f) => f.sensitive)) {
      throw new BadRequestException("Public forms cannot contain sensitive fields");
    }

    const patch: Partial<typeof hrForms.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.audience !== undefined) patch.audience = input.audience;
    if (input.workflowObjectType !== undefined) patch.workflowObjectType = input.workflowObjectType ?? null;
    if (input.schema !== undefined) patch.schema = input.schema;

    const [row] = await this.db
      .update(hrForms)
      .set(patch)
      .where(and(eq(hrForms.id, formId), eq(hrForms.orgId, orgId)))
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === "23505") throw new ConflictException("Form name or slug already exists");
        throw err;
      });
    if (!row) throw new NotFoundException("Form not found");
    return row;
  }

  async activateForm(orgId: string, formId: number) {
    const form = await this.loadForm(orgId, formId);
    if (form.schema.length === 0) {
      throw new BadRequestException("Cannot activate a form with no fields");
    }
    if (form.audience === "public" && form.schema.some((f) => f.sensitive)) {
      throw new BadRequestException("Public forms cannot contain sensitive fields");
    }
    const [row] = await this.db
      .update(hrForms)
      .set({ status: "active" })
      .where(and(eq(hrForms.id, formId), eq(hrForms.orgId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Form not found");
    return row;
  }

  async archiveForm(orgId: string, formId: number) {
    await this.loadForm(orgId, formId);
    const [row] = await this.db
      .update(hrForms)
      .set({ status: "archived" })
      .where(and(eq(hrForms.id, formId), eq(hrForms.orgId, orgId)))
      .returning();
    if (!row) throw new NotFoundException("Form not found");
    return row;
  }

  async deleteForm(orgId: string, formId: number) {
    await this.loadForm(orgId, formId);
    await this.db
      .update(hrForms)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrForms.id, formId), eq(hrForms.orgId, orgId)));
  }

  async getFormBySlug(orgId: string, slug: string): Promise<FormRow> {
    const [row] = await this.db
      .select()
      .from(hrForms)
      .where(and(eq(hrForms.orgId, orgId), eq(hrForms.slug, slug), isNull(hrForms.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("Form not found");
    return row;
  }
}
