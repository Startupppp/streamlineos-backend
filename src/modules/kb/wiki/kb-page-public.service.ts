import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  kbPages,
  kbPageAttachments,
} from "../../../db/schema";
import type { KbPageContent } from "../../../db/schema/kb/pages";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { withPublicToken } from "../../../common/tenant/with-public-token";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KB_PAGE_SEARCH_MAX_LIMIT } from "./dto/kb-pages.schemas";
import { actingMembershipId } from "../../../common/auth/principal";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { kbPagePrefixTsQuery } from "../core/collection/kb-page-text-query";
import { KB_PAGE_COLUMNS, type KbPageRow } from "./kb-page-columns";
import { hashPublicToken } from "./kb-public-token";
import {
  publicTokenColumnsFor,
  withoutUnsharedToken,
} from "./kb-page-share-visibility";
import { resolveProjectAccess } from "../../build/core/project-access";
import { KbPageWriterService } from "./kb-page-writer.service";

export interface KbPageSearchHit {
  id: number;
  title: string;
  icon: string | null;
  snippet: string;
}

@Injectable()
export class KbPagePublicService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly access: AccessService,
    private readonly writer: KbPageWriterService,
  ) {}

  private membershipId(user: CurrentUserContext): number | null {
    return user.principal === undefined
      ? null
      : actingMembershipId(user.principal);
  }

  async search(
    user: CurrentUserContext,
    q: string,
    limit: number = KB_PAGE_SEARCH_MAX_LIMIT,
    projectId?: number,
  ): Promise<{ items: KbPageSearchHit[]; hasMore: boolean; limit: number }> {
    if (projectId !== undefined) {
      const { hasAccess } = await resolveProjectAccess(
        this.db,
        this.access,
        user,
        projectId,
      );
      if (!hasAccess) throw new NotFoundException("Project not found");
    }
    const tsquery = kbPagePrefixTsQuery(q);
    if (tsquery === null) return { items: [], hasMore: false, limit };
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const projectFilter =
      projectId !== undefined ? eq(kbPages.projectId, projectId) : undefined;
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
  ): Promise<KbPageRow> {
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

    const { bumpRevision, ...tokenFields } = publicTokenColumnsFor(
      visibility,
      page.publicToken,
    );

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbPages)
        .set({
          visibility,
          ...tokenFields,
          aclRevision: sql`acl_revision + 1`,
          aclRevisionChangedAt: new Date(),
          ...(bumpRevision
            ? { publicTokenRevision: sql`public_token_revision + 1` }
            : {}),
        })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning(KB_PAGE_COLUMNS);
      if (!updated) throw new NotFoundException("Page not found");

      await this.writer.commitPageChange(tx, {
        orgId,
        actor: { userId: user.userId, membershipId: this.membershipId(user) },
        page: updated,
        changed: {},
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
    publicTokenRevision: number;
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
          publicTokenRevision: true,
        },
      }),
    );
    if (!page) throw new NotFoundException("Page not found");
    return page;
  }

  async validatePublicAttachment(
    token: string,
    fileKey: string,
  ): Promise<string> {
    const tokenHash = hashPublicToken(token);
    const page = await withPublicToken(this.db, tokenHash, (tx) =>
      tx.query.kbPages.findFirst({
        where: and(
          eq(kbPages.publicTokenHash, tokenHash),
          eq(kbPages.visibility, "public"),
          eq(kbPages.status, "published"),
          isNull(kbPages.deletedAt),
        ),
        columns: { orgId: true, id: true },
      }),
    );
    if (!page) throw new NotFoundException("Page not found");
    const attachment = await runInNewTenantTransaction(
      this.db,
      page.orgId,
      (tx) =>
        tx.query.kbPageAttachments.findFirst({
          where: and(
            eq(kbPageAttachments.orgId, page.orgId),
            eq(kbPageAttachments.pageId, page.id),
            eq(kbPageAttachments.fileKey, fileKey),
            isNull(kbPageAttachments.deletedAt),
          ),
          columns: { fileKey: true },
        }),
    );
    if (!attachment) throw new NotFoundException("Attachment not found");
    return attachment.fileKey;
  }
}
