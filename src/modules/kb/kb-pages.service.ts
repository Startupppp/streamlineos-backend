import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { kbPages, kbPageFavorites, kbPageTemplates, kbSpaces } from "../../db/schema";
import type { KbPageContent } from "../../db/schema/kb/pages";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationsService } from "../notifications/notifications.service";
import { PlanLimitsService } from "../billing/plan-limits.service";
import { extractMentionUserIds } from "./kb-page-content.util";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { CreatePageInput, UpdatePageInput, VerifyPageInput } from "./dto/kb-pages.schemas";
import { pageVisibleTo } from "./kb-page-visibility";
import { getAccessibleProjectIds } from "./kb-project-access.util";
import { computeVerificationInterval, shouldResetTrust } from "./kb-page-governance.util";
import { KbPageReviewsService } from "./kb-page-reviews.service";
import { KbIndexingService } from "./kb-indexing.service";
import { resyncPageLinks, snapshotIfNeeded } from "./kb-page-edit.util";

type PageRow = typeof kbPages.$inferSelect;

@Injectable()
export class KbPagesService {
  private readonly logger = new Logger(KbPagesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly reviews: KbPageReviewsService,
    private readonly indexing: KbIndexingService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async create(user: CurrentUserContext, input: CreatePageInput): Promise<PageRow> {
    const orgId = user.orgId;

    await this.planLimits.assertWithinLimit(orgId, "kbPages");

    let templateContent: KbPageContent | null = null;

    if (input.templateId) {
      const tpl = await this.db.query.kbPageTemplates.findFirst({
        where: and(eq(kbPageTemplates.id, input.templateId), eq(kbPageTemplates.orgId, orgId)),
        columns: { content: true },
      });
      if (tpl?.content) templateContent = tpl.content;
    }

    if (input.parentPageId) {
      const parent = await this.db.query.kbPages.findFirst({
        where: and(eq(kbPages.id, input.parentPageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
        columns: { id: true },
      });
      if (!parent) throw new NotFoundException("Parent page not found");
    }

    if (input.spaceId != null) {
      const space = await this.db.query.kbSpaces.findFirst({
        where: and(eq(kbSpaces.id, input.spaceId), eq(kbSpaces.orgId, orgId)),
        columns: { id: true },
      });
      if (!space) throw new NotFoundException("Space not found");
    }

    const siblings = await this.db
      .select({ sortOrder: kbPages.sortOrder })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          input.parentPageId
            ? eq(kbPages.parentPageId, input.parentPageId)
            : isNull(kbPages.parentPageId),
        ),
      )
      .orderBy(desc(kbPages.sortOrder))
      .limit(1);
    const maxSort = siblings[0]?.sortOrder ?? 0;

    const [page] = await this.db
      .insert(kbPages)
      .values({
        orgId,
        spaceId: input.spaceId ?? null,
        parentPageId: input.parentPageId ?? null,
        title: input.title ?? "",
        content: templateContent ?? null,
        sortOrder: maxSort + 100,
        createdById: user.userId,
        lastEditedById: user.userId,
        projectId: input.projectId ?? null,
      })
      .returning();
    if (!page) throw new Error("Failed to create page");
    return page;
  }

  async get(
    user: CurrentUserContext,
    pageId: number,
    canManage: boolean,
  ): Promise<PageRow & { ancestors: Pick<PageRow, "id" | "title">[]; isFavorite: boolean }> {
    const orgId = user.orgId;
    const projectIds = await this.getAccessibleProjectIds(user);
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt), pageVisibleTo(user, projectIds)),
    });
    if (!page) throw new NotFoundException("Page not found");

    const ancestors = await this.buildAncestors(orgId, page.parentPageId);

    const fav = await this.db.query.kbPageFavorites.findFirst({
      where: and(
        eq(kbPageFavorites.pageId, pageId),
        eq(kbPageFavorites.userId, user.userId),
        eq(kbPageFavorites.orgId, orgId),
      ),
      columns: { id: true },
    });

    const canShare = user.isOrgOwner || user.isPlatformAdmin || canManage || page.createdById === user.userId;

    return {
      ...page,
      publicToken: canShare ? page.publicToken : null,
      ancestors,
      isFavorite: !!fav,
    };
  }

  async update(user: CurrentUserContext, pageId: number, input: UpdatePageInput, canManage: boolean): Promise<PageRow> {
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
    });
    if (!current) throw new NotFoundException("Page not found");

    if (current.isLocked && !canManage) {
      throw new HttpException({ message: "Page is locked", code: "PAGE_LOCKED" }, HttpStatus.CONFLICT);
    }

    const values: Partial<typeof kbPages.$inferInsert> = { lastEditedById: user.userId };
    if (input.spaceId !== undefined) {
      if (input.spaceId != null) {
        const space = await this.db.query.kbSpaces.findFirst({
          where: and(eq(kbSpaces.id, input.spaceId), eq(kbSpaces.orgId, orgId)),
          columns: { id: true },
        });
        if (!space) throw new NotFoundException("Space not found");
      }
      values.spaceId = input.spaceId;
    }
    if (input.title !== undefined) values.title = input.title;
    if (input.icon !== undefined) values.icon = input.icon;
    if (input.coverImage !== undefined) values.coverImage = input.coverImage;
    if (input.content !== undefined) values.content = input.content;
    if (input.contentText !== undefined) values.contentText = input.contentText;
    if (input.status !== undefined) values.status = input.status;
    if (input.contentType !== undefined) values.contentType = input.contentType;
    if (input.ownerUserId !== undefined) values.ownerUserId = input.ownerUserId;

    const contentChanged = input.content !== undefined;
    if (shouldResetTrust(current.trustState, contentChanged)) {
      values.trustState = "unverified";
    }

    const result = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbPages)
        .set(values)
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Page not found");

      if (contentChanged && input.content !== undefined) {
        await snapshotIfNeeded(tx, orgId, updated, user.userId, input.changeSummary ?? null);
        await resyncPageLinks(tx, orgId, pageId, input.content);

        const oldMentions = new Set(extractMentionUserIds(current.content));
        const newMentions = extractMentionUserIds(input.content);
        const addedMentions = newMentions.filter((id) => !oldMentions.has(id));
        if (addedMentions.length > 0) {
          this.fireMentionNotifications(orgId, addedMentions, pageId, updated.title, user.userId).catch((err) => {
            this.logger.error(`Failed to send mention notifications: ${err}`);
          });
        }
      }

      return updated;
    });

    if (contentChanged) {
      this.indexing.indexPage(orgId, pageId).catch((err: unknown) => {
        this.logger.error(`Failed to index page ${pageId}: ${err}`);
      });
    }

    return result;
  }

  async lock(user: CurrentUserContext, pageId: number, isLocked: boolean): Promise<PageRow> {
    const orgId = user.orgId;
    const [updated] = await this.db
      .update(kbPages)
      .set({ isLocked, lastEditedById: user.userId })
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)))
      .returning();
    if (!updated) throw new NotFoundException("Page not found");
    return updated;
  }

  async publish(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    const result = await this.setStatus(user, pageId, "published");
    this.indexing.indexPage(user.orgId, pageId).catch((err: unknown) => {
      this.logger.error(`Failed to index page ${pageId}: ${err}`);
    });
    return result;
  }

  async archive(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    const result = await this.setStatus(user, pageId, "archived");
    this.indexing.removePageChunks(user.orgId, pageId).catch((err: unknown) => {
      this.logger.error(`Failed to remove chunks for page ${pageId}: ${err}`);
    });
    return result;
  }

  async unarchive(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    const result = await this.setStatus(user, pageId, "draft");
    this.indexing.removePageChunks(user.orgId, pageId).catch((err: unknown) => {
      this.logger.error(`Failed to remove chunks for page ${pageId}: ${err}`);
    });
    return result;
  }

  private async setStatus(
    user: CurrentUserContext,
    pageId: number,
    status: "draft" | "in_review" | "published" | "archived",
  ): Promise<PageRow> {
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!current) throw new NotFoundException("Page not found");
    const [updated] = await this.db
      .update(kbPages)
      .set({ status, lastEditedById: user.userId })
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Page not found");
    return updated;
  }

  async verify(user: CurrentUserContext, pageId: number, input: VerifyPageInput): Promise<PageRow> {
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true, contentType: true },
    });
    if (!current) throw new NotFoundException("Page not found");

    const days = computeVerificationInterval(current.contentType, input.intervalDays);
    const now = new Date();
    const verifiedUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const nextReviewAt = verifiedUntil;

    const [updated] = await this.db
      .update(kbPages)
      .set({
        trustState: "verified",
        verifiedById: user.userId,
        verifiedUntil,
        nextReviewAt,
        lastEditedById: user.userId,
      })
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Page not found");
    return updated;
  }

  async markStale(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!current) throw new NotFoundException("Page not found");

    const [updated] = await this.db
      .update(kbPages)
      .set({ trustState: "verification_expired", lastEditedById: user.userId })
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Page not found");

    await this.reviews.create(user, pageId, {
      type: "freshness",
      dueAt: new Date().toISOString(),
    });

    return updated;
  }

  async search(user: CurrentUserContext, q: string): Promise<{ id: number; title: string; icon: string | null; snippet: string }[]> {
    const words = q
      .trim()
      .split(/\s+/)
      .map(function sanitizeWord(w) {
        return w.replace(/[^\p{L}\p{N}]/gu, "");
      })
      .filter(function nonEmpty(w) {
        return w.length > 0;
      })
      .slice(0, 8);
    if (words.length === 0) return [];
    const orgId = user.orgId;
    const prefixQuery = words.map(function toPrefix(w) {
      return `${w}:*`;
    }).join(" & ");
    const tsquery = sql`to_tsquery('english', ${prefixQuery})`;
    const projectIds = await this.getAccessibleProjectIds(user);
    const rows = await this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        icon: kbPages.icon,
        snippet: sql<string>`ts_headline('english', coalesce(${kbPages.contentText},''), ${tsquery}, 'MaxWords=20, MinWords=5')`,
      })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          pageVisibleTo(user, projectIds),
          sql`${kbPages}.fts @@ ${tsquery}`,
        ),
      )
      .orderBy(sql`ts_rank(${kbPages}.fts, ${tsquery}) desc`)
      .limit(20);
    return rows;
  }

  async setVisibility(
    user: CurrentUserContext,
    pageId: number,
    visibility: "private" | "org" | "public",
    canManage: boolean,
  ): Promise<PageRow> {
    const orgId = user.orgId;
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true, createdById: true, visibility: true, publicToken: true },
    });
    if (!page) throw new NotFoundException("Page not found");

    const isCreator = page.createdById === user.userId;
    if (!isCreator && !canManage) {
      throw new NotFoundException("Page not found");
    }

    const update: Partial<typeof kbPages.$inferInsert> = { visibility };
    if (visibility === "public" && !page.publicToken) {
      const { randomBytes } = await import("node:crypto");
      update.publicToken = randomBytes(24).toString("hex");
    }

    const [updated] = await this.db
      .update(kbPages)
      .set(update)
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Page not found");
    return updated;
  }

  async getPublicPage(token: string): Promise<{
    title: string;
    icon: string | null;
    coverImage: string | null;
    content: KbPageContent | null;
    updatedAt: Date;
  }> {
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.publicToken, token),
        eq(kbPages.visibility, "public"),
        isNull(kbPages.deletedAt),
      ),
      columns: { title: true, icon: true, coverImage: true, content: true, updatedAt: true },
    });
    if (!page) throw new NotFoundException("Page not found");
    return page;
  }

  private getAccessibleProjectIds(user: CurrentUserContext): Promise<number[]> {
    return getAccessibleProjectIds(this.db, user);
  }

  private async buildAncestors(orgId: string, parentId: number | null): Promise<Pick<PageRow, "id" | "title">[]> {
    if (parentId === null) return [];
    const rows = await this.db.execute(sql`
      WITH RECURSIVE ancestors AS (
        SELECT id, title, parent_page_id, 1 AS depth
        FROM kb_pages
        WHERE id = ${parentId} AND org_id = ${orgId}
        UNION ALL
        SELECT p.id, p.title, p.parent_page_id, a.depth + 1
        FROM kb_pages p
        INNER JOIN ancestors a ON p.id = a.parent_page_id AND a.depth < 100
        WHERE p.org_id = ${orgId}
      )
      SELECT id, title FROM ancestors ORDER BY depth DESC
    `);
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      title: String(row.title ?? ""),
    }));
  }

  private async fireMentionNotifications(
    orgId: string,
    userIds: string[],
    pageId: number,
    pageTitle: string,
    actorId: string,
  ): Promise<void> {
    for (const userId of userIds) {
      if (userId === actorId) continue;
      try {
        await this.notifications.create({
          orgId,
          userId,
          type: "INFO",
          category: "SYSTEM",
          sourceModule: "kb",
          title: "You were mentioned in a page",
          message: `You were mentioned in "${pageTitle || "Untitled"}"`,
          link: `/knowledge/pages/${pageId}`,
        });
      } catch (err) {
        this.logger.error(`Mention notification failed for user ${userId}: ${err}`);
      }
    }
  }
}
