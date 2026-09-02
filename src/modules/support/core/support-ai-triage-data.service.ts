import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  kbArticleChunks,
  kbArticleRestrictions,
  kbArticles,
  kbSpaces,
  supportAiSuggestions,
  supportTickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { EmbeddingsService } from "../../ai/core/providers/embeddings.service";
import { OrgFeaturesService } from "../../ai/core/services/org-features.service";
import { KbAccessService } from "../../kb/core/kb-access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const KB_SIMILARITY_THRESHOLD = 0.2;

export type SuggestionType = (typeof supportAiSuggestions.$inferInsert)["type"];
export type KbSource = { articleId: number; title: string; url: string };

@Injectable()
export class SupportAiTriageDataService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly embeddings: EmbeddingsService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly kbAccess: KbAccessService,
  ) {}

  isEmbeddingsConfigured(): boolean {
    return this.embeddings.isConfigured();
  }

  async isAvailable(orgId: string): Promise<boolean> {
    const flags = await this.orgFeatures.getFlags(orgId);
    return flags.supportAi;
  }

  async getTicketOrThrow(orgId: string, ticketId: number) {
    const ticket = await this.db.query.supportTickets.findFirst({
      where: and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.orgId, orgId),
      ),
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return ticket;
  }

  async replacePendingSuggestions(
    orgId: string,
    ticketId: number,
    types: SuggestionType[],
  ): Promise<void> {
    await this.db
      .update(supportAiSuggestions)
      .set({
        status: "rejected",
        feedback: "superseded",
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(supportAiSuggestions.orgId, orgId),
          eq(supportAiSuggestions.ticketId, ticketId),
          inArray(supportAiSuggestions.type, types),
          eq(supportAiSuggestions.status, "pending"),
        ),
      );
  }

  async insertSuggestion(
    orgId: string,
    ticketId: number,
    type: SuggestionType,
    payload: Record<string, unknown>,
    confidence: number | null,
  ) {
    const [row] = await this.db
      .insert(supportAiSuggestions)
      .values({
        orgId,
        ticketId,
        type,
        payload,
        confidence: confidence !== null ? confidence.toFixed(3) : null,
      })
      .returning();
    return row;
  }

  async getTicketConfidence(orgId: string, ticketId: number): Promise<number> {
    const row = await this.db.query.supportAiSuggestions.findFirst({
      where: and(
        eq(supportAiSuggestions.orgId, orgId),
        eq(supportAiSuggestions.ticketId, ticketId),
        eq(supportAiSuggestions.type, "summary"),
        eq(supportAiSuggestions.status, "pending"),
      ),
      columns: { confidence: true },
      orderBy: [desc(supportAiSuggestions.createdAt)],
    });
    return row?.confidence !== null && row?.confidence !== undefined
      ? Number(row.confidence)
      : 1.0;
  }

  async searchKbForTicket(
    user: CurrentUserContext,
    query: string,
  ): Promise<KbSource[]> {
    if (!this.embeddings.isConfigured()) return [];
    const accessibleSpaceIds = await this.kbAccess.getAccessibleSpaceIds(user);
    if (accessibleSpaceIds.length === 0) return [];
    const principal = await this.kbAccess.getPrincipalIds(user);
    const vector = this.embeddings.toVectorLiteral(
      await this.embeddings.embedQuery(query, user.orgId, "support.kb-search"),
    );
    const distance = sql`${kbArticleChunks.embedding} <=> ${vector}::vector`;
    const kar = kbArticleRestrictions;
    const restrictionFilter = sql`(
      NOT EXISTS (
        SELECT 1 FROM ${kar}
        WHERE ${kar.articleId} = ${kbArticles.id}
          AND ${kar.orgId} = ${user.orgId}
          AND ${kar.level} = 'view'
      )
      OR EXISTS (
        SELECT 1 FROM ${kar}
        WHERE ${kar.articleId} = ${kbArticles.id}
          AND ${kar.orgId} = ${user.orgId}
          AND ${kar.level} = 'view'
          AND (${principal.membershipId !== null ? sql`${kar.membershipId} = ${principal.membershipId} OR ` : sql``}${
            principal.roleSlugs.length > 0
              ? sql`${kar.role} = ANY(${principal.roleSlugs})`
              : sql`false`
          })
      )
    )`;
    const results = await this.db
      .select({
        articleId: kbArticles.id,
        title: kbArticles.title,
        slug: kbArticles.slug,
        similarity: sql<number>`(1 - (${distance}))::float8`,
      })
      .from(kbArticleChunks)
      .innerJoin(kbArticles, eq(kbArticles.id, kbArticleChunks.articleId))
      .innerJoin(
        kbSpaces,
        and(eq(kbSpaces.id, kbArticles.spaceId), isNull(kbSpaces.deletedAt)),
      )
      .where(
        and(
          eq(kbArticleChunks.orgId, user.orgId),
          eq(kbArticles.status, "published"),
          inArray(kbArticles.spaceId, accessibleSpaceIds),
          restrictionFilter,
        ),
      )
      .orderBy(distance)
      .limit(12);
    const seen = new Set<number>();
    return results
      .filter((r) => r.similarity >= KB_SIMILARITY_THRESHOLD)
      .filter((r) =>
        seen.has(r.articleId) ? false : (seen.add(r.articleId), true),
      )
      .slice(0, 3)
      .map((r) => ({
        articleId: r.articleId,
        title: r.title,
        url: `/support/kb/articles/${r.slug}`,
      }));
  }
}
