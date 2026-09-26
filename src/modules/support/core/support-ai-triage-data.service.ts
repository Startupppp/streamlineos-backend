import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  supportAiSuggestions,
  supportTickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { OrgFeaturesService } from "../../ai/core/services/org-features.service";
import { KbAccessService } from "../../kb/core/kb-access.service";
import { searchSupportDocuments } from "../../kb/core/kb-support-documents";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const KB_SIMILARITY_THRESHOLD = 0.2;
const SUPPORT_KB_SEARCH_FEATURE = "support.kb-search";

export type SuggestionType = (typeof supportAiSuggestions.$inferInsert)["type"];
export type KbSource = { articleId: number; title: string; url: string };

@Injectable()
export class SupportAiTriageDataService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
    private readonly orgFeatures: OrgFeaturesService,
    private readonly kbAccess: KbAccessService,
  ) {}

  isEmbeddingsConfigured(): boolean {
    return this.aiGateway.isEmbeddingConfigured();
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
    if (!this.aiGateway.isEmbeddingConfigured()) return [];
    const scope = await runInTenantTransaction(
      this.db,
      async () => {
        const accessibleSpaceIds =
          await this.kbAccess.getAccessibleSpaceIds(user);
        if (accessibleSpaceIds.length === 0) return null;
        const principal = await this.kbAccess.getPrincipalIds(user);
        return { accessibleSpaceIds, principal };
      },
      { orgId: user.orgId },
    );
    if (!scope) return [];
    const embedResult = await this.aiGateway.embedQueryWithCredit({
      text: query,
      orgId: user.orgId,
      feature: SUPPORT_KB_SEARCH_FEATURE,
      charge: true,
    });
    if (!embedResult.ok) return [];
    const vector = embedResult.vectorLiteral;
    const results = await runInTenantTransaction(
      this.db,
      async () =>
        searchSupportDocuments(
          this.db,
          user.orgId,
          scope.principal,
          scope.accessibleSpaceIds,
          vector,
          12,
        ),
      { orgId: user.orgId },
    );
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
        url: `/support/kb/articles/${r.slug ?? r.articleId}`,
      }));
  }
}
