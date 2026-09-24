import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  kbPages,
  kbPageFavorites,
  kbPageTemplates,
  kbSpaces,
  organizationMembers,
} from "../../../db/schema";
import type { KbPageContent } from "../../../db/schema/kb/pages";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { NotificationsService } from "../../notifications/notifications.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { AccessService } from "../../access/access.service";
import { extractMentionUserIds } from "./kb-page-content.util";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KB_PAGE_SEARCH_MAX_LIMIT } from "./dto/kb-pages.schemas";
import type { CreatePageInput, UpdatePageInput } from "./dto/kb-pages.schemas";
import { shouldResetTrust } from "./kb-page-governance.util";
import {
  buildPageAncestors,
  describeLatestPageEdit,
  resyncPageLinks,
  snapshotIfNeeded,
  staleRevisionConflict,
} from "./kb-page-edit.util";
import { actingMembershipId } from "../../../common/auth/principal";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { kbPagePrefixTsQuery } from "../core/collection/kb-page-text-query";
import { KB_PAGE_COLUMNS, type KbPageRow } from "./kb-page-columns";
import { fireKbMentionNotifications } from "./kb-page-mention-notifications";
import { hashPublicToken, newPublicToken } from "./kb-public-token";
import { withoutUnsharedToken } from "./kb-page-share-visibility";
import { resolveProjectAccess } from "../../build/core/project-access";

type PageRow = KbPageRow;

export interface KbPageSearchHit {
  id: number;
  title: string;
  icon: string | null;
  snippet: string;
}

@Injectable()
export class KbPagesService {
  private readonly logger = new Logger(KbPagesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly planLimits: PlanLimitsService,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly access: AccessService,
  ) {}

  private membershipId(user: CurrentUserContext): number | null {
    return user.principal === undefined
      ? null
      : actingMembershipId(user.principal);
  }

  async create(
    user: CurrentUserContext,
    input: CreatePageInput,
  ): Promise<PageRow> {
    const orgId = user.orgId;

    await this.planLimits.assertWithinLimit(orgId, "kbPages");

    let templateContent: KbPageContent | null = null;

    if (input.templateId) {
      const tpl = await this.db.query.kbPageTemplates.findFirst({
        where: and(
          eq(kbPageTemplates.id, input.templateId),
          eq(kbPageTemplates.orgId, orgId),
        ),
        columns: { content: true },
      });
      if (tpl?.content) templateContent = tpl.content;
    }

    if (input.parentPageId) {
      const parent = await this.db.query.kbPages.findFirst({
        where: and(
          eq(kbPages.id, input.parentPageId),
          eq(kbPages.orgId, orgId),
          isNull(kbPages.deletedAt),
        ),
        columns: { id: true },
      });
      if (!parent) throw new NotFoundException("Parent page not found");
    }

    if (input.spaceId != null) {
      const space = await this.db.query.kbSpaces.findFirst({
        where: and(
          eq(kbSpaces.id, input.spaceId),
          eq(kbSpaces.orgId, orgId),
          isNull(kbSpaces.deletedAt),
        ),
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
        createdByMembershipId: this.membershipId(user),
        lastEditedById: user.userId,
        lastEditedByMembershipId: this.membershipId(user),
        projectId: input.projectId ?? null,
      })
      .returning(KB_PAGE_COLUMNS);
    if (!page) throw new Error("Failed to create page");
    return page;
  }

  async get(
    user: CurrentUserContext,
    pageId: number,
    canManage: boolean,
  ): Promise<
    PageRow & {
      ancestors: Pick<PageRow, "id" | "title">[];
      isFavorite: boolean;
      canEdit: boolean;
    }
  > {
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, orgId),
        isNull(kbPages.deletedAt),
        predicate,
      ),
      columns: { fts: false },
    });
    if (!page) throw new NotFoundException("Page not found");

    const [ancestors, editDecision, fav] = await Promise.all([
      buildPageAncestors(this.db, orgId, page.parentPageId),
      this.auth.resolvePageAccess(user, pageId, "edit"),
      this.db.query.kbPageFavorites.findFirst({
        where: and(
          eq(kbPageFavorites.pageId, pageId),
          eq(kbPageFavorites.userId, user.userId),
          eq(kbPageFavorites.orgId, orgId),
        ),
        columns: { id: true },
      }),
    ]);

    return {
      ...page,
      publicToken: withoutUnsharedToken(
        user,
        page,
        this.membershipId(user),
        canManage,
      ).publicToken,
      ancestors,
      isFavorite: !!fav,
      canEdit: editDecision.outcome === "allowed",
    };
  }

  async update(
    user: CurrentUserContext,
    pageId: number,
    input: UpdatePageInput,
    canManage: boolean,
  ): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      columns: { id: true, isLocked: true, trustState: true, content: true },
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, orgId),
        isNull(kbPages.deletedAt),
      ),
    });
    if (!current) throw new NotFoundException("Page not found");

    if (current.isLocked && !canManage) {
      throw new HttpException(
        { message: "Page is locked", code: "PAGE_LOCKED" },
        HttpStatus.CONFLICT,
      );
    }

    const values: Partial<typeof kbPages.$inferInsert> = {
      lastEditedById: user.userId,
      lastEditedByMembershipId: this.membershipId(user),
    };
    if (input.spaceId !== undefined) {
      if (input.spaceId != null) {
        const space = await this.db.query.kbSpaces.findFirst({
          where: and(
            eq(kbSpaces.id, input.spaceId),
            eq(kbSpaces.orgId, orgId),
            isNull(kbSpaces.deletedAt),
          ),
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
    if (input.ownerUserId !== undefined) {
      values.ownerUserId = input.ownerUserId;
      values.ownerMembershipId =
        input.ownerUserId === null
          ? null
          : ((
              await this.db.query.organizationMembers.findFirst({
                where: and(
                  eq(organizationMembers.orgId, orgId),
                  eq(organizationMembers.userId, input.ownerUserId),
                  eq(organizationMembers.status, "ACTIVE"),
                ),
                columns: { id: true },
              })
            )?.id ?? null);
    }

    const contentChanged = input.content !== undefined;
    const aclChanged = input.spaceId !== undefined;
    const needsReindex = contentChanged || aclChanged;
    if (shouldResetTrust(current.trustState, contentChanged)) {
      values.trustState = "unverified";
    }

    const revisionGuard = contentChanged
      ? input.expectedContentRevision
      : undefined;

    const result = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbPages)
        .set({
          ...values,
          ...(contentChanged
            ? { contentRevision: sql`content_revision + 1` }
            : {}),
          ...(aclChanged ? { aclRevision: sql`acl_revision + 1` } : {}),
        })
        .where(
          and(
            eq(kbPages.id, pageId),
            eq(kbPages.orgId, orgId),
            ...(revisionGuard === undefined
              ? []
              : [eq(kbPages.contentRevision, revisionGuard)]),
          ),
        )
        .returning(KB_PAGE_COLUMNS);
      if (!updated) {
        if (revisionGuard === undefined)
          throw new NotFoundException("Page not found");
        throw staleRevisionConflict(
          await describeLatestPageEdit(tx, orgId, pageId),
        );
      }

      if (contentChanged && input.content !== undefined) {
        await snapshotIfNeeded(
          tx,
          orgId,
          updated,
          user.userId,
          input.changeSummary ?? null,
          false,
          this.membershipId(user),
        );
        await resyncPageLinks(tx, orgId, pageId, input.content);

        const oldMentions = new Set(extractMentionUserIds(current.content));
        const newMentions = extractMentionUserIds(input.content);
        const addedMentions = newMentions.filter((id) => !oldMentions.has(id));
        if (addedMentions.length > 0) {
          fireKbMentionNotifications(this.notifications, this.logger, {
            orgId,
            userIds: addedMentions,
            pageId,
            pageTitle: updated.title,
            actorId: user.userId,
          }).catch((err) => {
            this.logger.error(`Failed to send mention notifications: ${err}`);
          });
        }
      }

      if (needsReindex) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "kb_page",
          aggregateId: String(pageId),
          aggregateVersion: Date.now(),
          eventType: "kb.content.index",
          payload: {
            contentType: "page",
            contentId: pageId,
            contentRevision: updated.contentRevision,
            aclRevision: updated.aclRevision,
          },
          occurredAt: new Date(),
        });
      }

      return updated;
    });

    return withoutUnsharedToken(user, result, this.membershipId(user), canManage);
  }

  async search(
    user: CurrentUserContext,
    q: string,
    limit: number = KB_PAGE_SEARCH_MAX_LIMIT,
    projectId?: number,
  ): Promise<{ items: KbPageSearchHit[]; hasMore: boolean; limit: number }> {
    if (projectId !== undefined) {
      const { hasAccess } = await resolveProjectAccess(this.db, this.access, user, projectId);
      if (!hasAccess) throw new NotFoundException("Project not found");
    }
    const tsquery = kbPagePrefixTsQuery(q);
    if (tsquery === null) return { items: [], hasMore: false, limit };
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const projectFilter = projectId !== undefined ? eq(kbPages.projectId, projectId) : undefined;
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
          predicate,
          sql`${kbPages}.fts @@ ${tsquery}`,
          ...(projectFilter !== undefined ? [projectFilter] : []),
        ),
      )
      .orderBy(sql`ts_rank(${kbPages}.fts, ${tsquery}) desc`)
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore, limit };
  }

  async setVisibility(
    user: CurrentUserContext,
    pageId: number,
    visibility: "private" | "org" | "public",
    canManage: boolean,
  ): Promise<PageRow> {
    const orgId = user.orgId;
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, orgId),
        isNull(kbPages.deletedAt),
      ),
      columns: {
        id: true,
        createdById: true,
        createdByMembershipId: true,
        visibility: true,
        publicToken: true,
      },
    });
    if (!page) throw new NotFoundException("Page not found");

    const isCreator =
      (this.membershipId(user) !== null &&
        page.createdByMembershipId === this.membershipId(user)) ||
      (page.createdByMembershipId === null && page.createdById === user.userId);
    if (!isCreator && !canManage) {
      throw new NotFoundException("Page not found");
    }

    const publicToken =
      visibility === "public" && !page.publicToken
        ? newPublicToken()
        : undefined;

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbPages)
        .set({
          visibility,
          ...(publicToken !== undefined
            ? { publicToken, publicTokenHash: hashPublicToken(publicToken) }
            : {}),
          aclRevision: sql`acl_revision + 1`,
        })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning(KB_PAGE_COLUMNS);
      if (!updated) throw new NotFoundException("Page not found");

      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_page",
        aggregateId: String(pageId),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: {
          contentType: "page",
          contentId: pageId,
          contentRevision: updated.contentRevision,
          aclRevision: updated.aclRevision,
        },
        occurredAt: new Date(),
      });

      return updated;
    });
  }

  async getPublicPage(token: string): Promise<{
    title: string;
    icon: string | null;
    coverImage: string | null;
    content: KbPageContent | null;
    updatedAt: Date;
  }> {
    const tokenHash = hashPublicToken(token);
    const page = await withPublicToken(this.db, tokenHash, (tx) =>
      tx.query.kbPages.findFirst({
        where: and(
          eq(kbPages.publicTokenHash, tokenHash),
          eq(kbPages.visibility, "public"),
          eq(kbPages.status, "published"),
          isNull(kbPages.deletedAt),
        ),
        columns: {
          title: true,
          icon: true,
          coverImage: true,
          content: true,
          updatedAt: true,
        },
      }),
    );
    if (!page) throw new NotFoundException("Page not found");
    return page;
  }
}
