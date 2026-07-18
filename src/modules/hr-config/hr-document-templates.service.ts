import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { and, desc, eq, ilike, ne } from "drizzle-orm";
import { documentTemplates, documentTemplateVersions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { extractVariables } from "./hr-config.helpers";
import type {
  CreateTemplateInput,
  TemplateListQuery,
  UpdateTemplateInput,
} from "./dto/document-templates.schemas";

type TemplateRow = typeof documentTemplates.$inferSelect;

@Injectable()
export class HrDocumentTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string, query: TemplateListQuery) {
    const conditions = [eq(documentTemplates.orgId, orgId), eq(documentTemplates.isActive, true)];
    if (query.type) conditions.push(eq(documentTemplates.type, query.type));

    return this.db
      .select()
      .from(documentTemplates)
      .where(and(...conditions))
      .orderBy(desc(documentTemplates.createdAt));
  }

  async getById(orgId: string, id: number): Promise<TemplateRow | null> {
    const [template] = await this.db
      .select()
      .from(documentTemplates)
      .where(and(eq(documentTemplates.id, id), eq(documentTemplates.orgId, orgId)))
      .limit(1);
    return template ?? null;
  }

  async create(orgId: string, userId: string, input: CreateTemplateInput) {
    const [existing] = await this.db
      .select({ id: documentTemplates.id })
      .from(documentTemplates)
      .where(
        and(
          eq(documentTemplates.orgId, orgId),
          eq(documentTemplates.isActive, true),
          ilike(documentTemplates.title, input.title.trim()),
        ),
      )
      .limit(1);
    if (existing) throw new ConflictException("A template with this name already exists");

    const variables = input.variables ?? extractVariables(input.htmlContent);

    const [template] = await this.db
      .insert(documentTemplates)
      .values({
        orgId,
        title: input.title,
        type: input.type,
        htmlContent: input.htmlContent,
        variables,
        createdBy: userId,
      })
      .returning();

    if (!template) throw new InternalServerErrorException("Failed to create template");

    return template;
  }

  async setDefault(existing: TemplateRow, isDefault: boolean) {
    const updated = await this.db.transaction(async (tx) => {
      if (isDefault) {
        await tx
          .update(documentTemplates)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(eq(documentTemplates.orgId, existing.orgId), eq(documentTemplates.isDefault, true)));
      }

      const [row] = await tx
        .update(documentTemplates)
        .set({ isDefault, updatedAt: new Date() })
        .where(eq(documentTemplates.id, existing.id))
        .returning();
      return row;
    });

    if (!updated) throw new InternalServerErrorException("Failed to update template");
    return updated;
  }

  async updateVersion(userId: string, existing: TemplateRow, input: UpdateTemplateInput) {
    if (input.title && input.title.trim().toLowerCase() !== existing.title.trim().toLowerCase()) {
      const [duplicate] = await this.db
        .select({ id: documentTemplates.id })
        .from(documentTemplates)
        .where(
          and(
            eq(documentTemplates.orgId, existing.orgId),
            eq(documentTemplates.isActive, true),
            ilike(documentTemplates.title, input.title.trim()),
            ne(documentTemplates.id, existing.id),
          ),
        )
        .limit(1);
      if (duplicate) throw new ConflictException("A template with this name already exists");
    }

    const contentChanging = input.htmlContent !== undefined && input.htmlContent !== existing.htmlContent;

    let variables = input.variables;
    if (input.htmlContent !== undefined && variables === undefined) {
      variables = extractVariables(input.htmlContent);
    }

    const updated = await this.db.transaction(async (tx) => {
      if (contentChanging) {
        await tx.insert(documentTemplateVersions).values({
          templateId: existing.id,
          orgId: existing.orgId,
          version: existing.version,
          title: existing.title,
          type: existing.type,
          htmlContent: existing.htmlContent,
          variables: existing.variables,
          archivedBy: userId,
        });
      }

      const [row] = await tx
        .update(documentTemplates)
        .set({
          ...(input.title !== undefined && { title: input.title }),
          ...(input.type !== undefined && { type: input.type }),
          ...(input.htmlContent !== undefined && { htmlContent: input.htmlContent }),
          ...(variables !== undefined && { variables }),
          version: existing.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(documentTemplates.id, existing.id))
        .returning();
      return row;
    });

    if (!updated) throw new InternalServerErrorException("Failed to update template");
    return updated;
  }

  async softDelete(orgId: string, id: number) {
    await this.db
      .update(documentTemplates)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(documentTemplates.id, id), eq(documentTemplates.orgId, orgId)));
    return { success: true };
  }

  buildPreview(template: TemplateRow) {
    const variables = extractVariables(template.htmlContent);
    const placeholderMap: Record<string, string> = {};
    for (const v of variables) {
      placeholderMap[v] = `[${v}]`;
    }
    const previewContent = template.htmlContent.replace(
      /\{\{([^}]+)\}\}/g,
      (_match, key: string) => `[${key.trim()}]`,
    );
    return { ...template, htmlContent: previewContent, previewVariables: placeholderMap };
  }

  listVersions(orgId: string, templateId: number) {
    return this.db
      .select()
      .from(documentTemplateVersions)
      .where(and(eq(documentTemplateVersions.templateId, templateId), eq(documentTemplateVersions.orgId, orgId)))
      .orderBy(desc(documentTemplateVersions.version));
  }
}
