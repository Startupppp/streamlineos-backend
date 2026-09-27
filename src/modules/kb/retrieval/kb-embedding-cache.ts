import { Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { EMBEDDING_MODEL } from "../../ai/core/providers/embeddings.service";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { logSideEffectFailure } from "../../../common/logger/side-effect";

const KB_SEARCH_FEATURE = "kb.search";

export function normalizeEmbeddableQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export class KbEmbeddingCache {
  private readonly logger = new Logger(KbEmbeddingCache.name);

  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly cache: CacheService | null,
  ) {}

  private queryEmbeddingCacheKey(orgId: string, text: string): string {
    return CACHE_KEYS.kbQueryEmbedding(
      orgId,
      EMBEDDING_MODEL,
      createHash("sha256").update(normalizeEmbeddableQuery(text)).digest("hex"),
    );
  }

  async embedOrDegrade(text: string, orgId: string): Promise<string | null> {
    const cache = this.cache;
    if (cache === null) return this.embedCharged(text, orgId);
    const key = this.queryEmbeddingCacheKey(orgId, text);
    const hit = await cache.get<string>(key);
    if (hit !== null) return hit;
    const vectorLiteral = await this.embedCharged(text, orgId);
    if (vectorLiteral !== null)
      await cache.set(key, vectorLiteral, CACHE_TTL.WEEK);
    return vectorLiteral;
  }

  private async embedCharged(
    text: string,
    orgId: string,
  ): Promise<string | null> {
    try {
      const embedResult = await this.aiGateway.embedQueryWithCredit({
        text,
        orgId,
        feature: KB_SEARCH_FEATURE,
        charge: true,
      });
      if (embedResult.ok) return embedResult.vectorLiteral;
      this.logger.warn(
        "KB semantic search embedding unavailable — keyword only",
        {
          orgId,
          kind: embedResult.kind,
        },
      );
      return null;
    } catch (err: unknown) {
      logSideEffectFailure("kb semantic search embedding", { orgId })(err);
      return null;
    }
  }
}
