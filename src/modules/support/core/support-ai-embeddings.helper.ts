import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne, or, sql, type SQL } from "drizzle-orm";
import { supportTicketEmbeddings, supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { EmbeddingsService, EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";
import { redactSensitiveData } from "../../ai/core/redaction.util";

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
    private readonly embeddings: EmbeddingsService,
  ) {}

  async upsertAndSearchSimilar(
    orgId: string,
    ticketId: number,
    title: string,
    description: string | null,
    limit: number,
  ): Promise<EmbeddingCandidate[]> {
    const text = redactSensitiveData(`${title}\n${description ?? ""}`.trim());
    const vector = await this.embeddings.embedQuery(text);
    const vectorLiteral = this.embeddings.toVectorLiteral(vector);

    await this.db
      .insert(supportTicketEmbeddings)
      .values({ orgId, ticketId, embedding: vector, embeddingModel: EMBEDDING_MODEL })
      .onConflictDoUpdate({
        target: supportTicketEmbeddings.ticketId,
        set: { embedding: vector, embeddingModel: EMBEDDING_MODEL, updatedAt: new Date() },
      });

    const distance = sql`${supportTicketEmbeddings.embedding} <=> ${vectorLiteral}::vector`;
    const conditions: SQL[] = [
      eq(supportTicketEmbeddings.orgId, orgId),
      ne(supportTicketEmbeddings.ticketId, ticketId),
      or(eq(supportTickets.status, "OPEN"), eq(supportTickets.status, "IN_PROGRESS"))!,
    ];

    return this.db
      .select({
        candidateTicketId: supportTicketEmbeddings.ticketId,
        title: supportTickets.title,
        similarity: sql<number>`(1 - (${distance}))::float8`,
      })
      .from(supportTicketEmbeddings)
      .innerJoin(supportTickets, eq(supportTickets.id, supportTicketEmbeddings.ticketId))
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
