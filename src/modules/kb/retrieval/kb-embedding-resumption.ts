import { ServiceUnavailableException } from "@nestjs/common";
import type { Logger } from "@nestjs/common";
import { InsufficientAiCreditsException } from "../../../common/http/api-exceptions";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { KbIndexingMetrics } from "../core/telemetry/kb-indexing-metrics";
import type { KbIngestionCheckpointService } from "./kb-ingestion-checkpoint.service";

export const KB_INDEXING_FEATURE = "kb.indexing";

export interface KbEmbeddingDeps {
  aiGateway: AiGatewayService;
  checkpoint: KbIngestionCheckpointService;
  logger: Logger;
  metrics?: KbIndexingMetrics;
}

export interface KbEmbeddingRequest {
  orgId: string;
  contentType: string;
  contentId: number;
  contentHash: string;
  chunks: string[];
  signal?: AbortSignal;
}

/**
 * Embeds only the chunks no checkpoint already covers, charges credits for those,
 * and checkpoints the new vectors so a later attempt resumes instead of re-paying.
 */
export async function embedChunksWithResumption(
  deps: KbEmbeddingDeps,
  request: KbEmbeddingRequest,
): Promise<number[][]> {
  const { aiGateway, checkpoint, logger, metrics } = deps;
  const { orgId, contentType, contentId, contentHash, chunks, signal } = request;

  const cached = await checkpoint.loadCheckpoints(
    orgId,
    contentType,
    contentId,
    contentHash,
  );

  const resumedFrom = cached.size > 0 ? Math.min(...cached.keys()) : chunks.length;
  if (cached.size > 0)
    logger.log("KB ingestion resuming from checkpoint", {
      orgId,
      contentType,
      contentId,
      cachedChunks: cached.size,
      totalChunks: chunks.length,
      resumedFrom,
    });

  const vectors = new Array<number[]>(chunks.length);
  const pending: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const hit = cached.get(i);
    if (hit === undefined) pending.push(i);
    else vectors[i] = hit;
  }

  if (pending.length === 0) return vectors;

  const embedResult = await aiGateway.embedBatchWithCredit({
    texts: pending.map((i) => chunks[i]),
    orgId,
    feature: KB_INDEXING_FEATURE,
    charge: true,
  });

  if (!embedResult.ok) {
    if (embedResult.kind === "quota_exceeded")
      throw new InsufficientAiCreditsException({ message: embedResult.message });
    throw new ServiceUnavailableException(embedResult.message);
  }

  metrics?.embedded(pending.length);

  if (signal?.aborted) throw new DOMException("KB ingestion cancelled", "AbortError");

  pending.forEach((chunkIndex, n) => {
    vectors[chunkIndex] = embedResult.vectors[n];
  });

  await checkpoint.saveCheckpoints(
    orgId,
    contentType,
    contentId,
    contentHash,
    pending.map((chunkIndex) => ({
      chunkIndex,
      content: chunks[chunkIndex],
      embedding: vectors[chunkIndex],
    })),
  );

  logger.log("KB ingestion chunks embedded", {
    orgId,
    contentType,
    contentId,
    embedded: pending.length,
    reused: cached.size,
    total: chunks.length,
  });

  return vectors;
}
