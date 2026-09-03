import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { kbPageTemplates, kbPages } from "../../../db/schema";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreatePageTemplateInput } from "./dto/kb-page-templates.schemas";

type TemplateRow = typeof kbPageTemplates.$inferSelect;

const TEMPLATE_LIST_CAP = 200;

@Injectable()
export class KbPageTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(orgId: string): Promise<TemplateRow[]> {
    return this.db
      .select()
      .from(kbPageTemplates)
      .where(eq(kbPageTemplates.orgId, orgId))
      .orderBy(kbPageTemplates.name)
      .limit(TEMPLATE_LIST_CAP);
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
