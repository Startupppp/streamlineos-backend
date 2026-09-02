import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, ne, or, sql, type SQL } from "drizzle-orm";
import { supportTicketEmbeddings, supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import { redactSensitiveData } from "../../ai/core/redaction.util";

const SUPPORT_EMBEDDING_FEATURE = "support.embedding";
const DUPLICATE_SIMILARITY_THRESHOLD = 0.86;
const ROOT_CAUSE_SIMILARITY_THRESHOLD = 0.75;

export type EmbeddingCandidate = {
  candidateTicketId: number;
  title: string;
  similarity: number;
};

@Injectable()
export class SupportAiEmbeddingsHelper {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly aiGateway: AiGatewayService,
  ) {}

  async upsertAndSearchSimilar(
    orgId: string,
    ticketId: number,
    title: string,
    description: string | null,
    limit: number,
  ): Promise<EmbeddingCandidate[]> {
    const text = redactSensitiveData(`${title}\n${description ?? ""}`.trim());
    const embedResult = await this.aiGateway.embedQueryWithCredit({
      text,
      orgId,
      feature: SUPPORT_EMBEDDING_FEATURE,
      charge: true,
    });
    if (!embedResult.ok) {
      if (embedResult.kind === "quota_exceeded")
        throw new InsufficientAiCreditsException({ message: embedResult.message });
      throw new ServiceUnavailableException(embedResult.message);
    }
    const { vector, vectorLiteral } = embedResult;

    await this.db
      .insert(supportTicketEmbeddings)
      .values({
        orgId,
        ticketId,
        embedding: vector,
        embeddingModel: EMBEDDING_MODEL,
      })
      .onConflictDoUpdate({
        target: supportTicketEmbeddings.ticketId,
        set: {
          embedding: vector,
          embeddingModel: EMBEDDING_MODEL,
          updatedAt: new Date(),
        },
      });

    const distance = sql`${supportTicketEmbeddings.embedding} <=> ${vectorLiteral}::vector`;
    const conditions: SQL[] = [
      eq(supportTicketEmbeddings.orgId, orgId),
      ne(supportTicketEmbeddings.ticketId, ticketId),
      or(
        eq(supportTickets.status, "OPEN"),
        eq(supportTickets.status, "IN_PROGRESS"),
      )!,
    ];

    return this.db
      .select({
        candidateTicketId: supportTicketEmbeddings.ticketId,
        title: supportTickets.title,
        similarity: sql<number>`(1 - (${distance}))::float8`,
      })
      .from(supportTicketEmbeddings)
      .innerJoin(
        supportTickets,
        eq(supportTickets.id, supportTicketEmbeddings.ticketId),
      )
      .where(and(...conditions))
      .orderBy(distance)
      .limit(limit);
  }

  getDuplicateThreshold(): number {
    return DUPLICATE_SIMILARITY_THRESHOLD;
  }

  getRootCauseThreshold(): number {
    return ROOT_CAUSE_SIMILARITY_THRESHOLD;
  }
}
