import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  kbArticles,
  kbEvents,
  kbSpaces,
  organizationMembers,
  supportKnowledgeGaps,
  supportTickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { KbArticlesService } from "../../kb/help-centre/kb-articles.service";
import { KbEventsService } from "../../kb/core/kb-events.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { logger } from "../../../common/logger/logger.service";
import { SupportKnowledgeGapStatus } from "../../../db/schema/support/support-kb-gap";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";
import type { AiUsageMeta } from "../../ai/core/gateway/ai-gateway.types";
import { assertOrganizationActor } from "../../../common/organization/organization-actor";
import {
  buildEvidenceText,
  clusterTicketEmbeddings,
  findKbOwners,
  getSearchGaps,
  upsertGap,
  type GapRow,
} from "./lib/gap-detection";


const GAP_DRAFT_FEATURE = "support.kb-gap-draft";

const gapDraftSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

interface GapWithDeflection extends GapRow {
  deflectionCount: number;
  proposedArticleTitle: string | null;
}

@Injectable()
export class SupportKbGapService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly kbArticles: KbArticlesService,
    private readonly kbEvents: KbEventsService,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {}

  async detectGaps(orgId: string): Promise<{ created: number; updated: number }> {
    const ticketClusters = await clusterTicketEmbeddings(this.db, orgId);
    const searchGaps = await getSearchGaps(this.db, orgId);

    let created = 0;
    let updated = 0;

    for (const cluster of ticketClusters) {
      const clusterKey = `cluster:${cluster.representativeTicketId}`;
      const result = await upsertGap(this.db, orgId, clusterKey, cluster.representativeQuestion, {
        ticketCount: cluster.ticketIds.length,
        sampleTicketIds: cluster.ticketIds.slice(0, 10),
        evidence: { searchQueries: [], relatedTicketIds: cluster.ticketIds },
      });
      if (result === "created") created++;
      else if (result === "updated") updated++;
    }

    for (const gap of searchGaps) {
      if (!gap.query) continue;
      const clusterKey = `search:${gap.query}`;
      const result = await upsertGap(this.db, orgId, clusterKey, gap.query, {
        ticketCount: gap.count,
        sampleTicketIds: [],
        evidence: { searchQueries: [{ query: gap.query, count: gap.count }], relatedTicketIds: [] },
      });
      if (result === "created") created++;
      else if (result === "updated") updated++;
    }

    return { created, updated };
  }

  async proposeDraft(orgId: string, gapId: number, actorUserId: string, userCtx?: CurrentUserContext): Promise<GapRow & { aiUsage?: AiUsageMeta }> {
    const gap = await this.db.query.supportKnowledgeGaps.findFirst({
      where: and(eq(supportKnowledgeGaps.id, gapId), eq(supportKnowledgeGaps.orgId, orgId)),
    });
    if (!gap) throw new NotFoundException("Knowledge gap not found");
    if (
      gap.status === SupportKnowledgeGapStatus.DISMISSED ||
      gap.status === SupportKnowledgeGapStatus.PUBLISHED
    ) {
      throw new BadRequestException(`Gap is already ${gap.status.toLowerCase()}`);
    }

    const [actorMember] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, actorUserId)))
      .limit(1);
    const actorMembershipId = actorMember?.id ?? null;

    const space = await this.db.query.kbSpaces.findFirst({
      where: and(eq(kbSpaces.orgId, orgId), isNull(kbSpaces.deletedAt)),
      columns: { id: true },
    });
    if (!space) throw new BadRequestException("No KB space found for this organisation");

    const kbOwnerIds = await findKbOwners(this.db, orgId);

    const evidenceText = buildEvidenceText(gap);
    const gatewayResult = await this.aiGateway.invokeStructuredWithUsage({
      actor: { orgId, userId: actorUserId },
      feature: GAP_DRAFT_FEATURE,
      tier: "standard",
      maxTokens: 1024,
      charge: true,
      schema: gapDraftSchema,
      prompt: {
        system:
          "You are a technical writer. Given a recurring support question or topic, draft a clear, helpful knowledge base article in Markdown. Include a short problem statement followed by a resolution or explanation. Return JSON with 'title' (string) and 'body' (markdown string).",
        user: `Recurring question: "${gap.representativeQuestion}"\n\nEvidence:\n${evidenceText}`,
      },
    });

    if (!gatewayResult.ok) {
      logger.error("support kb-gap draft failed", { orgId, gapId, kind: gatewayResult.kind });
      if (gatewayResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: gatewayResult.message });
      throw new BadRequestException("AI draft generation failed");
    }

    const { title, body } = gatewayResult.data;
    const gapAiUsage = gatewayResult.aiUsage;
    const contentText = body.replace(/[#*_`[\]()]/g, "").slice(0, 500);

    const ctx: CurrentUserContext = userCtx ?? {
      orgId,
      userId: actorUserId,
      role: "support",
      isOrgOwner: false,
      tokenScopes: null,
      sessionId: "",
      principal: ACCOUNT_ONLY_PRINCIPAL,
    };
    const article = await this.kbArticles.create(ctx, {
      spaceId: space.id,
      title,
      content: body,
      contentText,
      status: "draft" as const,
      visibility: "internal" as const,
    });

    const eventActor = await assertOrganizationActor(this.db, orgId, {
      kind: "user",
      userId: actorUserId,
    }).catch(() => null);

    await this.kbEvents.record(orgId, "ticket_deflected", {
      actorMembershipId,
      articleId: article.id,
      metadata: { feature: "kb_gap_draft", gapId },
    });

    const [updated] = await this.db
      .update(supportKnowledgeGaps)
      .set({
        proposedArticleId: article.id,
        draftedBy: actorUserId,
        status: SupportKnowledgeGapStatus.ROUTED,
        updatedAt: new Date(),
      })
      .where(and(eq(supportKnowledgeGaps.id, gapId), eq(supportKnowledgeGaps.orgId, orgId)))
      .returning();

    if (kbOwnerIds.length > 0) {
      await this.notificationDispatch
        .emit({
          eventKey: "support.kb.gap.routed",
          orgId,
          actorUserId,
          targetUserIds: kbOwnerIds,
          entityType: "kb_gap",
          entityId: String(gapId),
          link: `/support/knowledge-gaps`,
          title: "KB gap needs review",
          message: gap.representativeQuestion,
        })
        .catch((err: unknown) => {
          logger.warn("support kb-gap notification failed", {
            orgId,
            gapId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }

    if (!updated) throw new NotFoundException("Gap not found after update");
    return { ...updated, aiUsage: gapAiUsage };
  }

  async listGaps(
    orgId: string,
    cursor?: number,
    limit = 50,
  ): Promise<{ gaps: GapWithDeflection[]; nextCursor: number | null }> {
    const cap = Math.min(limit, 100);
    const rows = await this.db
      .select({
        id: supportKnowledgeGaps.id,
        orgId: supportKnowledgeGaps.orgId,
        clusterKey: supportKnowledgeGaps.clusterKey,
        representativeQuestion: supportKnowledgeGaps.representativeQuestion,
        ticketCount: supportKnowledgeGaps.ticketCount,
        sampleTicketIds: supportKnowledgeGaps.sampleTicketIds,
        status: supportKnowledgeGaps.status,
        proposedArticleId: supportKnowledgeGaps.proposedArticleId,
        draftedBy: supportKnowledgeGaps.draftedBy,
        reviewedBy: supportKnowledgeGaps.reviewedBy,
        evidence: supportKnowledgeGaps.evidence,
        createdAt: supportKnowledgeGaps.createdAt,
        updatedAt: supportKnowledgeGaps.updatedAt,
        proposedArticleTitle: kbArticles.title,
      })
      .from(supportKnowledgeGaps)
      .leftJoin(kbArticles, eq(kbArticles.id, supportKnowledgeGaps.proposedArticleId))
      .where(
        and(
          eq(supportKnowledgeGaps.orgId, orgId),
          cursor !== undefined ? lt(supportKnowledgeGaps.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(supportKnowledgeGaps.id))
      .limit(cap + 1);

    const hasMore = rows.length > cap;
    const page = hasMore ? rows.slice(0, cap) : rows;
    const nextCursor = hasMore && page.at(-1) ? page.at(-1)!.id : null;

    const articleIds = page
      .map((r) => r.proposedArticleId)
      .filter((id): id is number => id !== null);

    const deflectionCounts = new Map<number, number>();
    if (articleIds.length > 0) {
      const counts = await this.db
        .select({
          articleId: kbEvents.articleId,
          count: sql<number>`count(*)::int`,
        })
        .from(kbEvents)
        .where(
          and(
            eq(kbEvents.orgId, orgId),
            eq(kbEvents.eventType, "helpful_vote"),
            inArray(kbEvents.articleId, articleIds),
          ),
        )
        .groupBy(kbEvents.articleId);

      for (const c of counts) {
        if (c.articleId !== null) deflectionCounts.set(c.articleId, c.count);
      }
    }

    const gaps: GapWithDeflection[] = page.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      clusterKey: r.clusterKey,
      representativeQuestion: r.representativeQuestion,
      ticketCount: r.ticketCount,
      sampleTicketIds: r.sampleTicketIds,
      status: r.status,
      proposedArticleId: r.proposedArticleId,
      draftedBy: r.draftedBy,
      reviewedBy: r.reviewedBy,
      evidence: r.evidence,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deflectionCount: r.proposedArticleId !== null ? (deflectionCounts.get(r.proposedArticleId) ?? 0) : 0,
      proposedArticleTitle: r.proposedArticleTitle ?? null,
    }));

    return { gaps, nextCursor };
  }

  async dismissGap(orgId: string, gapId: number): Promise<GapRow> {
    const [updated] = await this.db
      .update(supportKnowledgeGaps)
      .set({ status: SupportKnowledgeGapStatus.DISMISSED, updatedAt: new Date() })
      .where(and(eq(supportKnowledgeGaps.id, gapId), eq(supportKnowledgeGaps.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Knowledge gap not found");
    return updated;
  }

  async runDetectAllOrgs(): Promise<{ processed: number; errors: number }> {
    let processed = 0;
    let errors = 0;

    await forEachOrg(this.db, "support-kb-gap-detect", async (tx, orgId) => {
      const [hasOpenTicket] = await tx
        .select({ id: supportTickets.id })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.orgId, orgId),
            or(eq(supportTickets.status, "OPEN"), eq(supportTickets.status, "IN_PROGRESS")),
          ),
        )
        .limit(1);
      if (!hasOpenTicket) return;

      try {
        await this.detectGaps(orgId);
        processed++;
      } catch (err: unknown) {
        errors++;
        logger.error("support kb-gap detect failed for org", {
          orgId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    });

    return { processed, errors };
  }

}
