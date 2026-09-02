import { Injectable } from "@nestjs/common";
import { OpenAIEmbeddings } from "@langchain/openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_TIMEOUT_MS = 20_000;
const MAX_EMBED_BATCH = 64;

@Injectable()
export class EmbeddingsService {
  private embeddings: OpenAIEmbeddings | null = null;

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

  async embedBatchRaw(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = this.getEmbeddings();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH)
      out.push(...(await client.embedDocuments(texts.slice(i, i + MAX_EMBED_BATCH))));
    return out;
  }

  toVectorLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
  }
}
