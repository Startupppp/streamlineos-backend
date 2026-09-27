import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { SQL, and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { hrTemplates, hrTemplateRenders } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { HrTemplateRenderService } from "./hr-template-render.service";
import { buildDefaultTemplates } from "./seed-default-templates";
import {
  VALID_TRANSITIONS,
  type CreateTemplateInput,
  type HrTemplateStatus,
  type RenderTemplateInput,
  type TemplateListQuery,
  type TemplateRendersQuery,
  type UpdateTemplateInput,
} from "./dto/hr-templates.schemas";
import { TEMPLATE_VARIABLES } from "./hr-template-variables";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";

type TemplateRow = typeof hrTemplates.$inferSelect;

const TEMPLATE_SEARCH_CAP = 500;

@Injectable()
export class HrTemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly renderService: HrTemplateRenderService,
  ) {}

  async list(orgId: string, query: TemplateListQuery) {
    const conditions = [eq(hrTemplates.orgId, orgId), isNull(hrTemplates.deletedAt)];
    if (query.kind) conditions.push(eq(hrTemplates.kind, query.kind));
    if (query.status) conditions.push(eq(hrTemplates.status, query.status));
    if (query.search) conditions.push(await this.templateSearchCondition(query.search));

    const baseWhere = and(...conditions);
    const position = decodeCursor(query.cursor);
    const where = and(
      baseWhere,
      position ? keysetBeforeId(hrTemplates.updatedAt, hrTemplates.id, position) : undefined,
    );

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select({
          id: hrTemplates.id,
          orgId: hrTemplates.orgId,
          kind: hrTemplates.kind,
          name: hrTemplates.name,
          description: hrTemplates.description,
          status: hrTemplates.status,
          version: hrTemplates.version,
          parentTemplateId: hrTemplates.parentTemplateId,
          variablesUsed: hrTemplates.variablesUsed,
          letterType: hrTemplates.letterType,
          createdBy: hrTemplates.createdBy,
          updatedBy: hrTemplates.updatedBy,
          deletedAt: hrTemplates.deletedAt,
          createdAt: hrTemplates.createdAt,
          updatedAt: hrTemplates.updatedAt,
        })
        .from(hrTemplates)
        .where(where)
        .orderBy(desc(hrTemplates.updatedAt), desc(hrTemplates.id))
        .limit(query.limit + 1),
      this.db
        .select({ total: count() })
        .from(hrTemplates)
        .where(baseWhere),
    ]);
    const page = buildCursorPage(rows, query.limit, (template) => ({
      sortValue: template.updatedAt.toISOString(),
      id: String(template.id),
    }));
    return { data: page.data, total, pagination: page.pagination };
  }

  private async templateSearchCondition(search: string): Promise<SQL> {
    const fallback = or(
      ilike(hrTemplates.name, `%${search}%`),
      ilike(hrTemplates.description, `%${search}%`),
    );
    if (!fallback) throw new InternalServerErrorException("Failed to build template search fallback");
    const rows = await this.db.execute(
      sql`SELECT app.search_hr_template_ids(${search}, ${TEMPLATE_SEARCH_CAP + 1}) AS id`,
    );
    if (rows.length === 0) return sql`false`;
    if (rows.length > TEMPLATE_SEARCH_CAP) return fallback;
    const ids = rows.map((r) => Number(r["id"]));
    return inArray(hrTemplates.id, ids);
  }

  async getById(orgId: string, templateId: number): Promise<TemplateRow> {
    const [row] = await this.db
      .select()
      .from(hrTemplates)
      .where(and(eq(hrTemplates.id, templateId), eq(hrTemplates.orgId, orgId), isNull(hrTemplates.deletedAt)))
      .limit(1);
    if (!row) throw new NotFoundException("Template not found");
    return row;
  }

  async create(orgId: string, userId: string, input: CreateTemplateInput): Promise<TemplateRow> {
    await this.assertNameUnique(orgId, input.kind, input.name, 1, null);

    const [row] = await this.db
      .insert(hrTemplates)
      .values({
        orgId,
        kind: input.kind,
        name: input.name,
        description: input.description,
        content: input.content,
        variablesUsed: input.variablesUsed ?? [],
        letterType: input.letterType,
        createdBy: userId,
      })
      .returning();

    if (!row) throw new InternalServerErrorException("Failed to create template");
    return row;
  }

  async update(orgId: string, userId: string, templateId: number, input: UpdateTemplateInput): Promise<TemplateRow> {
    const existing = await this.getById(orgId, templateId);
    if (existing.status !== "draft" && existing.status !== "review") {
      throw new BadRequestException("Only draft or review templates can be edited");
    }

    if (input.name && input.name !== existing.name) {
      await this.assertNameUnique(orgId, existing.kind, input.name, existing.version, templateId);
    }

    const [updated] = await this.db
      .update(hrTemplates)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.content !== undefined && { content: input.content }),
        ...(input.variablesUsed !== undefined && { variablesUsed: input.variablesUsed }),
        ...(input.letterType !== undefined && { letterType: input.letterType }),
        updatedBy: userId,
      })
      .where(and(eq(hrTemplates.id, templateId), eq(hrTemplates.orgId, orgId)))
      .returning();

    if (!updated) throw new InternalServerErrorException("Failed to update template");
    return updated;
  }

  async transition(orgId: string, userId: string, templateId: number, to: HrTemplateStatus): Promise<TemplateRow> {
    const existing = await this.getById(orgId, templateId);
    const allowed = VALID_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(`Cannot transition from ${existing.status} to ${to}`);
    }

    const [updated] = await this.db
      .update(hrTemplates)
      .set({ status: to, updatedBy: userId })
      .where(and(eq(hrTemplates.id, templateId), eq(hrTemplates.orgId, orgId)))
      .returning();

    if (!updated) throw new InternalServerErrorException("Failed to update template status");
    return updated;
  }

  async createNewVersion(orgId: string, userId: string, templateId: number): Promise<TemplateRow> {
    const existing = await this.getById(orgId, templateId);
    if (existing.status !== "active") {
      throw new BadRequestException("Only active templates can be versioned");
    }

    const newVersion = existing.version + 1;
    await this.assertNameUnique(orgId, existing.kind, existing.name, newVersion, null);

    const [row] = await this.db
      .insert(hrTemplates)
      .values({
        orgId,
        kind: existing.kind,
        name: existing.name,
        description: existing.description,
        status: "draft",
        version: newVersion,
        parentTemplateId: existing.id,
        content: existing.content,
        variablesUsed: existing.variablesUsed,
        letterType: existing.letterType,
        createdBy: userId,
      })
      .returning();

    if (!row) throw new InternalServerErrorException("Failed to create new version");
    return row;
  }

  async render(
    orgId: string,
    userId: string,
    templateId: number,
    input: RenderTemplateInput,
  ) {
    const template = await this.getById(orgId, templateId);

    if (input.includeSensitive) {
      // caller must hold hr:sensitive:view — enforced in controller before reaching here
    }

    const bodyHtml = template.content["bodyHtml"];
    const body = typeof bodyHtml === "string" ? bodyHtml : undefined;
    const subjectRaw = template.content["subject"];
    const subject = typeof subjectRaw === "string" ? subjectRaw : undefined;

    const ctx = await this.renderService.buildContext(
      orgId,
      userId,
      input.employeeId,
      input.extraContext,
      input.includeSensitive,
    );
    // A template preview with nobody selected used to print ⟦missing:employee.firstName⟧
    // and "reach out to us at .". Sample values fill only the holes.
    if (input.employeeId === undefined) {
      const samples = this.renderService.buildPreviewContext();
      for (const [key, value] of Object.entries(samples)) {
        if (!ctx[key]) ctx[key] = value;
      }
    }

    const outputHtml = body ? this.renderService.renderHtml(body, ctx) : "";
    const renderedSubject = subject ? this.renderService.renderHtml(subject, ctx) : undefined;

    const contextSnapshot: Record<string, unknown> = {
      employeeId: input.employeeId,
      extraContext: input.extraContext,
      includeSensitive: input.includeSensitive,
    };

    const [renderRow] = await this.db
      .insert(hrTemplateRenders)
      .values({
        orgId,
        templateId,
        templateVersion: template.version,
        renderedForEmployeeId: input.employeeId,
        renderedBy: userId,
        contextSnapshot,
        outputHtml,
      })
      .returning();

    return { outputHtml, renderedSubject, renderId: renderRow?.id, templateVersion: template.version };
  }

  async listRenders(
    orgId: string,
    templateId: number,
    query: TemplateRendersQuery,
  ) {
    await this.getById(orgId, templateId);
    const position = decodeCursor(query.cursor);
    if (query.cursor !== undefined && !position) {
      throw new BadRequestException("Invalid pagination cursor");
    }

    const conditions = [
      eq(hrTemplateRenders.orgId, orgId),
      eq(hrTemplateRenders.templateId, templateId),
    ];
    if (position) {
      conditions.push(
        keysetBeforeId(
          hrTemplateRenders.createdAt,
          hrTemplateRenders.id,
          position,
        ),
      );
    }

    const rows = await this.db
      .select()
      .from(hrTemplateRenders)
      .where(and(...conditions))
      .orderBy(desc(hrTemplateRenders.createdAt), desc(hrTemplateRenders.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (render) => ({
      sortValue: render.createdAt.toISOString(),
      id: String(render.id),
    }));
  }

  async seedDefaults(orgId: string, userId: string) {
    const existing = await this.db
      .select({ id: hrTemplates.id })
      .from(hrTemplates)
      .where(and(eq(hrTemplates.orgId, orgId), isNull(hrTemplates.deletedAt)))
      .limit(1);

    if (existing.length > 0) {
      return { seeded: false, message: "Templates already exist for this org" };
    }

    const defaults = buildDefaultTemplates();
    const values = defaults.map((t) => ({
      orgId,
      kind: t.kind,
      name: t.name,
      description: t.description,
      status: "active" as const,
      content: t.content,
      variablesUsed: t.variablesUsed,
      letterType: t.letterType,
      createdBy: userId,
    }));

    await this.db.insert(hrTemplates).values(values);
    return { seeded: true, count: values.length };
  }

  listVariables() {
    return TEMPLATE_VARIABLES;
  }

  private async assertNameUnique(
    orgId: string,
    kind: TemplateRow["kind"],
    name: string,
    version: number,
    excludeId: number | null,
  ) {
    const normalizedName = name.trim().toLowerCase();
    const [existing] = await this.db
      .select({ id: hrTemplates.id })
      .from(hrTemplates)
      .where(
        and(
          eq(hrTemplates.orgId, orgId),
          eq(hrTemplates.kind, kind),
          eq(sql`lower(${hrTemplates.name})`, normalizedName),
          eq(hrTemplates.version, version),
          isNull(hrTemplates.deletedAt),
        ),
      )
      .limit(1);

    if (existing && existing.id !== excludeId) {
      throw new ConflictException("A template with this name, kind, and version already exists");
    }
  }
}
