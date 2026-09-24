import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { kbPageTemplates, kbPages } from "../../../db/schema";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreatePageTemplateInput,
  ListPageTemplatesQuery,
} from "./dto/kb-page-templates.schemas";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import {
  buildCursorPage,
  decodeCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";

type TemplateRow = typeof kbPageTemplates.$inferSelect;

@Injectable()
export class KbPageTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(
    orgId: string,
    query: ListPageTemplatesQuery,
  ): Promise<CursorPage<TemplateRow>> {
    const position = decodeCursor(query.cursor);
    const rows = await this.db
      .select()
      .from(kbPageTemplates)
      .where(
        and(
          eq(kbPageTemplates.orgId, orgId),
          position
            ? keysetAfterValue(kbPageTemplates.name, kbPageTemplates.id, position)
            : undefined,
        ),
      )
      .orderBy(asc(kbPageTemplates.name), asc(kbPageTemplates.id))
      .limit(query.limit + 1);

    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.name,
      id: String(row.id),
    }));
  }

  async create(user: CurrentUserContext, input: CreatePageTemplateInput): Promise<TemplateRow> {
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
      return template;
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
}
