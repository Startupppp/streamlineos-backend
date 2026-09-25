import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, ilike, inArray, isNull } from "drizzle-orm";
import { kbPageTemplates, kbPages, users } from "../../../db/schema";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreatePageTemplateInput,
  ListPageTemplatesQuery,
  UpdatePageTemplateInput,
} from "./dto/kb-page-templates.schemas";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import {
  buildCursorPage,
  decodeCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";

type TemplateRow = typeof kbPageTemplates.$inferSelect;
type TemplateWithOwner = TemplateRow & { createdByName: string | null };

const TEMPLATE_COLUMNS = {
  id: kbPageTemplates.id,
  orgId: kbPageTemplates.orgId,
  name: kbPageTemplates.name,
  icon: kbPageTemplates.icon,
  description: kbPageTemplates.description,
  content: kbPageTemplates.content,
  createdById: kbPageTemplates.createdById,
  createdAt: kbPageTemplates.createdAt,
  updatedAt: kbPageTemplates.updatedAt,
};

@Injectable()
export class KbPageTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(
    orgId: string,
    query: ListPageTemplatesQuery,
  ): Promise<CursorPage<TemplateWithOwner>> {
    const position = decodeCursor(query.cursor);
    const rows = await this.db
      .select(TEMPLATE_COLUMNS)
      .from(kbPageTemplates)
      .where(
        and(
          eq(kbPageTemplates.orgId, orgId),
          query.q ? ilike(kbPageTemplates.name, `${query.q}%`) : undefined,
          position
            ? keysetAfterValue(kbPageTemplates.name, kbPageTemplates.id, position)
            : undefined,
        ),
      )
      .orderBy(asc(kbPageTemplates.name), asc(kbPageTemplates.id))
      .limit(query.limit + 1);

    const withOwner = await this.attachOwnerNames(rows);

    return buildCursorPage(withOwner, query.limit, (row) => ({
      sortValue: row.name,
      id: String(row.id),
    }));
  }

  async create(
    user: CurrentUserContext,
    input: CreatePageTemplateInput,
  ): Promise<TemplateWithOwner> {
    const orgId = user.orgId;
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, input.fromPageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true, content: true, icon: true },
    });
    if (!page) throw new NotFoundException("Source page not found");

    try {
      const [template] = await this.db
        .insert(kbPageTemplates)
        .values({
          orgId,
          name: input.name,
          description: input.description ?? null,
          icon: page.icon,
          content: page.content ?? null,
          createdById: user.userId,
        })
        .returning();
      if (!template)
        throw new ConflictException("Failed to create template");
      return this.loadWithOwner(orgId, template.id);
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException("A template with that name already exists");
      throw err;
    }
  }

  async update(
    orgId: string,
    templateId: number,
    input: UpdatePageTemplateInput,
  ): Promise<TemplateWithOwner> {
    const patch: Partial<typeof kbPageTemplates.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;

    try {
      const [updated] = await this.db
        .update(kbPageTemplates)
        .set(patch)
        .where(and(eq(kbPageTemplates.id, templateId), eq(kbPageTemplates.orgId, orgId)))
        .returning({ id: kbPageTemplates.id });
      if (!updated) throw new NotFoundException("Template not found");
      return this.loadWithOwner(orgId, templateId);
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException("A template with that name already exists");
      throw err;
    }
  }

  async remove(orgId: string, templateId: number): Promise<void> {
    const [deleted] = await this.db
      .delete(kbPageTemplates)
      .where(and(eq(kbPageTemplates.id, templateId), eq(kbPageTemplates.orgId, orgId)))
      .returning({ id: kbPageTemplates.id });
    if (!deleted) throw new NotFoundException("Template not found");
  }

  private async loadWithOwner(
    orgId: string,
    templateId: number,
  ): Promise<TemplateWithOwner> {
    const [row] = await this.db
      .select(TEMPLATE_COLUMNS)
      .from(kbPageTemplates)
      .where(and(eq(kbPageTemplates.id, templateId), eq(kbPageTemplates.orgId, orgId)));
    if (!row) throw new NotFoundException("Template not found");
    const [withOwner] = await this.attachOwnerNames([row]);
    return withOwner;
  }

  private async attachOwnerNames(
    rows: TemplateRow[],
  ): Promise<TemplateWithOwner[]> {
    const creatorIds = [
      ...new Set(
        rows
          .map((row) => row.createdById)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (creatorIds.length === 0)
      return rows.map((row) => ({ ...row, createdByName: null }));

    const owners = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, creatorIds));
    const ownerMap = new Map(owners.map((owner) => [owner.id, owner.name]));

    return rows.map((row) => ({
      ...row,
      createdByName: row.createdById ? (ownerMap.get(row.createdById) ?? null) : null,
    }));
  }
}
