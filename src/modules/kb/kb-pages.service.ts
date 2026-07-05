import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { kbPages, kbPageFavorites, kbPageLinks, kbPageVersions, kbPageVisits, kbPageTemplates, kbSpaces } from "../../db/schema";
import type { KbPageContent } from "../../db/schema/kb/pages";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { NotificationsService } from "../notifications/notifications.service";
import { extractMentionUserIds, extractPageLinkIds } from "./kb-page-content.util";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { CreatePageInput, UpdatePageInput, VerifyPageInput } from "./dto/kb-pages.schemas";
import { pageVisibleTo } from "./kb-page-visibility";
import { computeVerificationInterval, shouldResetTrust } from "./kb-page-governance.util";
import { KbPageReviewsService } from "./kb-page-reviews.service";
import { KbIndexingService } from "./kb-indexing.service";

const VERSION_WINDOW_MS = 10 * 60 * 1000;
const MAX_VERSIONS = 100;

type PageRow = typeof kbPages.$inferSelect;
type KbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class KbPagesService {
  private readonly logger = new Logger(KbPagesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly reviews: KbPageReviewsService,
    private readonly indexing: KbIndexingService,
  ) {}

  async create(user: CurrentUserContext, input: CreatePageInput): Promise<PageRow> {
    const orgId = user.orgId;
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
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt), pageVisibleTo(user)),
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

    return this.db.transaction(async (tx) => {
      if (contentChanged) {
        await this.snapshotIfNeeded(tx, orgId, current, user.userId);
      }

      const [updated] = await tx
        .update(kbPages)
        .set(values)
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Page not found");

      if (contentChanged && input.content !== undefined) {
        await this.resyncLinks(tx, orgId, pageId, input.content);

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
          pageVisibleTo(user),
          sql`${kbPages}.fts @@ ${tsquery}`,
        ),
      )
      .orderBy(sql`ts_rank(${kbPages}.fts, ${tsquery}) desc`)
      .limit(20);
    return rows;
  }

  async getRecent(user: CurrentUserContext): Promise<PageRow[]> {
    const orgId = user.orgId;
    const visits = await this.db
      .select({ pageId: kbPageVisits.pageId })
      .from(kbPageVisits)
      .where(and(eq(kbPageVisits.orgId, orgId), eq(kbPageVisits.userId, user.userId)))
      .orderBy(desc(kbPageVisits.visitedAt))
      .limit(20);

    if (visits.length === 0) return [];
    const ids = visits.map((v) => v.pageId);
    const pages = await this.db
      .select()
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          pageVisibleTo(user),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[])`,
        ),
      );
    const pageMap = new Map(pages.map((p) => [p.id, p]));
    return ids.map((id) => pageMap.get(id)).filter((p): p is PageRow => p !== undefined);
  }

  async getFavorites(user: CurrentUserContext): Promise<PageRow[]> {
    const orgId = user.orgId;
    const favs = await this.db
      .select({ pageId: kbPageFavorites.pageId })
      .from(kbPageFavorites)
      .where(and(eq(kbPageFavorites.orgId, orgId), eq(kbPageFavorites.userId, user.userId)))
      .orderBy(asc(kbPageFavorites.sortOrder), asc(kbPageFavorites.createdAt))
      .limit(50);

    if (favs.length === 0) return [];
    const ids = favs.map((f) => f.pageId);
    const pages = await this.db
      .select()
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          pageVisibleTo(user),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[])`,
        ),
      );
    const pageMap = new Map(pages.map((p) => [p.id, p]));
    return ids.map((id) => pageMap.get(id)).filter((p): p is PageRow => p !== undefined);
  }

  async addFavorite(user: CurrentUserContext, pageId: number): Promise<{ success: boolean }> {
    const orgId = user.orgId;
    await this.assertPageAccessible(user, pageId);
    await this.db
      .insert(kbPageFavorites)
      .values({ orgId, pageId, userId: user.userId })
      .onConflictDoNothing();
    return { success: true };
  }

  async removeFavorite(user: CurrentUserContext, pageId: number): Promise<{ success: boolean }> {
    const orgId = user.orgId;
    await this.db
      .delete(kbPageFavorites)
      .where(
        and(
          eq(kbPageFavorites.pageId, pageId),
          eq(kbPageFavorites.userId, user.userId),
          eq(kbPageFavorites.orgId, orgId),
        ),
      );
    return { success: true };
  }

  async recordVisit(user: CurrentUserContext, pageId: number): Promise<{ success: boolean }> {
    const orgId = user.orgId;
    await this.assertPageAccessible(user, pageId);
    await this.db
      .insert(kbPageVisits)
      .values({ orgId, pageId, userId: user.userId, visitedAt: new Date() })
      .onConflictDoUpdate({
        target: [kbPageVisits.pageId, kbPageVisits.userId],
        set: { visitedAt: new Date() },
      });
    return { success: true };
  }

  async getBacklinks(user: CurrentUserContext, pageId: number): Promise<Pick<PageRow, "id" | "title" | "icon">[]> {
    const orgId = user.orgId;
    await this.assertPageAccessible(user, pageId);
    const links = await this.db
      .select({ sourcePageId: kbPageLinks.sourcePageId })
      .from(kbPageLinks)
      .where(and(eq(kbPageLinks.orgId, orgId), eq(kbPageLinks.targetPageId, pageId)));

    if (links.length === 0) return [];
    const ids = links.map((l) => l.sourcePageId);
    return this.db
      .select({ id: kbPages.id, title: kbPages.title, icon: kbPages.icon })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          pageVisibleTo(user),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::int[])`,
        ),
      );
  }

  async listVersions(user: CurrentUserContext, pageId: number): Promise<(typeof kbPageVersions.$inferSelect)[]> {
    const orgId = user.orgId;
    await this.assertPageAccessible(user, pageId);
    return this.db
      .select()
      .from(kbPageVersions)
      .where(and(eq(kbPageVersions.pageId, pageId), eq(kbPageVersions.orgId, orgId)))
      .orderBy(desc(kbPageVersions.versionNumber));
  }

  async getVersion(user: CurrentUserContext, pageId: number, versionNumber: number): Promise<typeof kbPageVersions.$inferSelect> {
    const orgId = user.orgId;
    await this.assertPageAccessible(user, pageId);
    const version = await this.db.query.kbPageVersions.findFirst({
      where: and(
        eq(kbPageVersions.pageId, pageId),
        eq(kbPageVersions.versionNumber, versionNumber),
        eq(kbPageVersions.orgId, orgId),
      ),
    });
    if (!version) throw new NotFoundException("Version not found");
    return version;
  }

  async restoreVersion(user: CurrentUserContext, pageId: number, versionNumber: number, canManage: boolean): Promise<PageRow> {
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
    });
    if (!current) throw new NotFoundException("Page not found");

    if (current.isLocked && !canManage) {
      throw new HttpException({ message: "Page is locked", code: "PAGE_LOCKED" }, HttpStatus.CONFLICT);
    }

    const version = await this.db.query.kbPageVersions.findFirst({
      where: and(
        eq(kbPageVersions.pageId, pageId),
        eq(kbPageVersions.versionNumber, versionNumber),
        eq(kbPageVersions.orgId, orgId),
      ),
    });
    if (!version) throw new NotFoundException("Version not found");

    return this.db.transaction(async (tx) => {
      await this.snapshotIfNeeded(tx, orgId, current, user.userId);

      const [updated] = await tx
        .update(kbPages)
        .set({
          title: version.title,
          content: version.content ?? undefined,
          lastEditedById: user.userId,
        })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Page not found");

      if (version.content) {
        await this.resyncLinks(tx, orgId, pageId, version.content);
      }

      return updated;
    });
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

  private async assertPageAccessible(user: CurrentUserContext, pageId: number): Promise<void> {
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
        pageVisibleTo(user),
      ),
      columns: { id: true },
    });
    if (!page) throw new NotFoundException("Page not found");
  }

  private async buildAncestors(orgId: string, parentId: number | null): Promise<Pick<PageRow, "id" | "title">[]> {
    const ancestors: Pick<PageRow, "id" | "title">[] = [];
    let currentId = parentId;
    const visited = new Set<number>();
    while (currentId !== null && currentId !== undefined) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const parent = await this.db.query.kbPages.findFirst({
        where: and(eq(kbPages.id, currentId), eq(kbPages.orgId, orgId)),
        columns: { id: true, title: true, parentPageId: true },
      });
      if (!parent) break;
      ancestors.unshift({ id: parent.id, title: parent.title });
      currentId = parent.parentPageId;
    }
    return ancestors;
  }

  private async snapshotIfNeeded(
    tx: KbTransaction,
    orgId: string,
    current: PageRow,
    authorId: string,
  ): Promise<void> {
    const newest = await tx.query.kbPageVersions.findFirst({
      where: and(eq(kbPageVersions.pageId, current.id), eq(kbPageVersions.orgId, orgId)),
      orderBy: [desc(kbPageVersions.versionNumber)],
      columns: { versionNumber: true, createdAt: true },
    });

    const windowPassed =
      !newest || Date.now() - newest.createdAt.getTime() > VERSION_WINDOW_MS;

    if (!windowPassed) return;

    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(kbPageVersions)
      .where(and(eq(kbPageVersions.pageId, current.id), eq(kbPageVersions.orgId, orgId)));
    const total = countRow?.count ?? 0;

    if (total >= MAX_VERSIONS) {
      const oldest = await tx.query.kbPageVersions.findFirst({
        where: and(eq(kbPageVersions.pageId, current.id), eq(kbPageVersions.orgId, orgId)),
        orderBy: [asc(kbPageVersions.versionNumber)],
        columns: { id: true },
      });
      if (oldest) {
        await tx.delete(kbPageVersions).where(eq(kbPageVersions.id, oldest.id));
      }
    }

    const nextVer = (newest?.versionNumber ?? 0) + 1;
    await tx.insert(kbPageVersions).values({
      orgId,
      pageId: current.id,
      versionNumber: nextVer,
      title: current.title,
      content: current.content ?? null,
      authorId,
    });
  }

  private async resyncLinks(
    tx: KbTransaction,
    orgId: string,
    pageId: number,
    content: unknown,
  ): Promise<void> {
    const linkIds = extractPageLinkIds(content);

    await tx
      .delete(kbPageLinks)
      .where(and(eq(kbPageLinks.sourcePageId, pageId), eq(kbPageLinks.orgId, orgId), eq(kbPageLinks.targetType, "page")));

    if (linkIds.length === 0) return;

    const validPages = await tx
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(linkIds.map((id) => sql`${id}`), sql`, `)}]::int[])`,
        ),
      );

    if (validPages.length === 0) return;
    await tx
      .insert(kbPageLinks)
      .values(validPages.map((p) => ({ orgId, sourcePageId: pageId, targetPageId: p.id })))
      .onConflictDoNothing();
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