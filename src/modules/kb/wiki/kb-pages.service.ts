import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
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
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreatePageInput, UpdatePageInput } from "./dto/kb-pages.schemas";
import { shouldResetTrust } from "./kb-page-governance.util";
import {
  buildPageAncestors,
  describeLatestPageEdit,
  staleRevisionConflict,
} from "./kb-page-edit.util";
import { actingMembershipId } from "../../../common/auth/principal";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { KB_PAGE_COLUMNS, type KbPageRow } from "./kb-page-columns";
import { KbPageWriterService } from "./kb-page-writer.service";
import { withoutUnsharedToken } from "./kb-page-share-visibility";
import { resolveProjectAccess } from "../../build/core";
import { KbReadMetrics } from "../analytics/kb-read-metrics";
import { PROCESS_CELL_ID } from "../../../common/cell-resources/cell-id";

type PageRow = KbPageRow;

function isDocumentNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function documentPlainText(content: KbPageContent | null): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isDocumentNode(node)) return;
    const text = node.text;
    if (typeof text === "string" && text.length > 0) parts.push(text);
    visit(node.content);
    visit(node.children);
  };
  visit(content);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

@Injectable()
export class KbPagesService {
  private readonly logger = new Logger(KbPagesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly writer: KbPageWriterService,
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
    let usedTemplateId: number | null = null;

    if (input.templateId) {
      const tpl = await this.db.query.kbPageTemplates.findFirst({
        where: and(
          eq(kbPageTemplates.id, input.templateId),
          eq(kbPageTemplates.orgId, orgId),
        ),
        columns: { content: true },
      });
      if (tpl) usedTemplateId = input.templateId;
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

    if (input.projectId != null) {
      const { hasAccess } = await resolveProjectAccess(
        this.db,
        this.access,
        user,
        input.projectId,
      );
      if (!hasAccess) throw new NotFoundException("Project not found");
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

    const templateText = documentPlainText(templateContent);
    const contentText =
      templateText.length > 0 ? templateText : (input.title ?? "");

    return this.db.transaction(async (tx) => {
      const [page] = await tx
        .insert(kbPages)
        .values({
          orgId,
          spaceId: input.spaceId ?? null,
          parentPageId: input.parentPageId ?? null,
          title: input.title ?? "",
          content: templateContent ?? null,
          contentText,
          sortOrder: maxSort + 100,
          createdById: user.userId,
          createdByMembershipId: this.membershipId(user),
          lastEditedById: user.userId,
          lastEditedByMembershipId: this.membershipId(user),
          projectId: input.projectId ?? null,
        })
        .returning(KB_PAGE_COLUMNS);
      if (!page) throw new Error("Failed to create page");

      if (usedTemplateId !== null) {
        await tx
          .update(kbPageTemplates)
          .set({
            useCount: sql`${kbPageTemplates.useCount} + 1`,
            lastUsedAt: new Date(),
          })
          .where(
            and(
              eq(kbPageTemplates.id, usedTemplateId),
              eq(kbPageTemplates.orgId, orgId),
            ),
          );
      }

      await this.writer.commitPageChange(tx, {
        orgId,
        actor: { userId: user.userId, membershipId: this.membershipId(user) },
        action: "kb.page.created",
        page,
        changed: {},
        writeOutcome: "created",
      });

      return page;
    });
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
    const metrics = KbReadMetrics.begin({
      orgId: user.orgId,
      actorStanding: user.isOrgOwner ? "owner" : "member",
      orgCell: PROCESS_CELL_ID,
    });
    try {
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

      metrics.finish("found");
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
    } catch (error) {
      if (error instanceof NotFoundException) metrics.finish("not_found");
      else if (error instanceof ForbiddenException) metrics.finish("denied");
      else metrics.finish("error");
      throw error;
    }
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

    if (input.ownerUserId !== undefined && !canManage) {
      throw new ForbiddenException("Only a manager can change the page owner");
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
    const ownerChanged = input.ownerUserId !== undefined;
    const aclChanged = input.spaceId !== undefined || ownerChanged;
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
          ...(aclChanged
            ? {
                aclRevision: sql`acl_revision + 1`,
                aclRevisionChangedAt: new Date(),
              }
            : {}),
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

      if (needsReindex) {
        await this.writer.commitPageChange(tx, {
          orgId,
          actor: { userId: user.userId, membershipId: this.membershipId(user) },
          action: "kb.page.updated",
          page: updated,
          changed: contentChanged
            ? {
                content: {
                  newContent: input.content!,
                  previousContent: current.content ?? null,
                  changeSummary: input.changeSummary ?? null,
                },
              }
            : {},
        });
      }

      if (ownerChanged) {
        await this.audit.logCritical({
          action: "kb.page.owner_changed",
          userId: user.userId,
          orgId,
          resourceType: "kb_page",
          resourceId: String(pageId),
          metadata: { pageId, ownerUserId: input.ownerUserId },
        });
      }

      return updated;
    });

    return withoutUnsharedToken(
      user,
      result,
      this.membershipId(user),
      canManage,
    );
  }

}
