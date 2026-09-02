import { Injectable } from "@nestjs/common";
import { OpenAIEmbeddings } from "@langchain/openai";
import { createHash } from "node:crypto";
import { AiUsageService } from "../services/ai-usage.service";

export const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_TIMEOUT_MS = 20_000;
const MAX_EMBED_BATCH = 64;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

@Injectable()
export class EmbeddingsService {
  private embeddings: OpenAIEmbeddings | null = null;
  private readonly dedup = new Map<string, Promise<number[]>>();

  constructor(private readonly usage: AiUsageService) {}

  private getApiKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  private getEmbeddings(): OpenAIEmbeddings {
    if (this.embeddings) return this.embeddings;
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required for embeddings (KB RAG). OpenRouter has no embeddings endpoint — set OPENAI_API_KEY even when AI_LLM_PROVIDER=openrouter.",
      );
    }
    this.embeddings = new OpenAIEmbeddings({
      apiKey,
      model: EMBEDDING_MODEL,
      timeout: EMBEDDING_TIMEOUT_MS,
    });
    return this.embeddings;
  }

  async embedQueryRaw(text: string): Promise<number[]> {
    return this.getEmbeddings().embedQuery(text);
  }

  async embedQuery(text: string, orgId: string, feature: string): Promise<number[]> {
    const vec = await this.embedQueryRaw(text);
    await this.usage
      .track({
        orgId,
        feature,
        model: EMBEDDING_MODEL,
        promptTokens: estimateTokens(text),
        completionTokens: 0,
        metadata: { tokenEstimate: true },
      })
      .catch(() => undefined);
    return vec;
  }

  async embedBatchRaw(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = this.getEmbeddings();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH)
      out.push(...(await client.embedDocuments(texts.slice(i, i + MAX_EMBED_BATCH))));
    return out;
  }

  async embedBatch(texts: string[], orgId: string, feature: string): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out = await this.embedBatchRaw(texts);
    const totalTokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
    await this.usage
      .track({
        orgId,
        feature,
        model: EMBEDDING_MODEL,
        promptTokens: totalTokens,
        completionTokens: 0,
        metadata: { tokenEstimate: true, batchSize: texts.length },
      })
      .catch(() => undefined);
    return out;
  }

  embedQueryDeduped(text: string, orgId: string, feature: string): Promise<number[]> {
    const hash = createHash("sha256").update(text).digest("hex");
    let inflight = this.dedup.get(hash);
    if (!inflight) {
      inflight = this.getEmbeddings()
        .embedQuery(text)
        .finally(() => { this.dedup.delete(hash); });
      this.dedup.set(hash, inflight);
    }
    const estimatedTokens = estimateTokens(text);
    return inflight.then(async (vec) => {
      await this.usage
        .track({
          orgId,
          feature,
          model: EMBEDDING_MODEL,
          promptTokens: estimatedTokens,
          completionTokens: 0,
          metadata: { tokenEstimate: true },
        })
        .catch(() => undefined);
      return vec;
    });
  }

  toVectorLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
  }
}
