import { Injectable } from "@nestjs/common";
import { OpenAIEmbeddings } from "@langchain/openai";
import { createHash } from "node:crypto";

export const EMBEDDING_MODEL = "text-embedding-3-small";

@Injectable()
export class EmbeddingsService {
  private embeddings: OpenAIEmbeddings | null = null;
  private readonly dedup = new Map<string, Promise<number[]>>();

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
    this.embeddings = new OpenAIEmbeddings({ apiKey, model: EMBEDDING_MODEL });
    return this.embeddings;
  }

  embedQuery(text: string): Promise<number[]> {
    return this.getEmbeddings().embedQuery(text);
  }

  embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return Promise.resolve([]);
    return this.getEmbeddings().embedDocuments(texts);
  }

  embedQueryDeduped(text: string): Promise<number[]> {
    const hash = createHash("sha256").update(text).digest("hex");
    const inflight = this.dedup.get(hash);
    if (inflight) return inflight;
    const promise = this.getEmbeddings()
      .embedQuery(text)
      .finally(() => { this.dedup.delete(hash); });
    this.dedup.set(hash, promise);
    return promise;
  }

  toVectorLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
  }
}
