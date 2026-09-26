import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { kbCategories, kbPageFeedback } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";
import {
  adjustPublicDocumentFeedback,
  findPublicDocumentBySlug,
  findPublicDocumentIdBySlug,
  incrementPublicDocumentView,
  listPublicDocuments,
} from "../kb/core/kb-public-documents";
import type { KbFeedbackInput, KbListInput } from "./dto/public.schemas";

@Injectable()
export class KbService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(input: KbListInput) {
    const { org, categoryId, search, cursor } = input;
    const pageSize = Math.min(input.pageSize, PAGE_SIZE_CAP);
    const position = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && !position)
      throw new BadRequestException("Invalid pagination cursor");

    const categories = await this.db
      .select({
        id: kbCategories.id,
        name: kbCategories.name,
        slug: kbCategories.slug,
        description: kbCategories.description,
        icon: kbCategories.icon,
        sortOrder: kbCategories.sortOrder,
      })
      .from(kbCategories)
      .where(
        and(eq(kbCategories.orgId, org), eq(kbCategories.isPublished, true)),
      )
      .orderBy(asc(kbCategories.sortOrder), asc(kbCategories.name));

    const rows = await listPublicDocuments(this.db, org, {
      categoryId,
      search,
      position: position ?? undefined,
      pageSize,
    });

    const page = buildCursorPage(rows, pageSize, (row) => ({
      sortValue: row.publishedAt?.toISOString() ?? "",
      id: String(row.id),
    }));
    return { categories, articles: page.data, pagination: page.pagination };
  }

  async getArticle(slug: string, org: string) {
    const article = await findPublicDocumentBySlug(this.db, org, slug);
    if (!article) throw new NotFoundException("Article not found");

    await incrementPublicDocumentView(this.db, org, article.id);

    return { ...article, views: (article.views ?? 0) + 1 };
  }

  async submitFeedback(slug: string, org: string, input: KbFeedbackInput) {
    const { helpful, comment, visitorId } = input;

    const article = await findPublicDocumentIdBySlug(this.db, org, slug);
    if (!article) throw new NotFoundException("Article not found");

    const recorded = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(kbPageFeedback)
        .values({
          orgId: org,
          pageId: article.id,
          helpful,
          comment: comment ?? null,
          visitorId: visitorId ?? null,
        })
        .onConflictDoNothing({
          target: [
            kbPageFeedback.orgId,
            kbPageFeedback.pageId,
            kbPageFeedback.visitorId,
          ],
        })
        .returning({ id: kbPageFeedback.id });

      if (inserted.length === 0) return false;

      await adjustPublicDocumentFeedback(tx, org, article.id, helpful);
      return true;
    });

    return { success: true, recorded };
  }
}
