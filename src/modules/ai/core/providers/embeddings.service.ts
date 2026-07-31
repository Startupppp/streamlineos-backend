import { Injectable } from "@nestjs/common";
import { OpenAIEmbeddings } from "@langchain/openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

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
    this.embeddings = new OpenAIEmbeddings({ apiKey, model: EMBEDDING_MODEL });
    return this.embeddings;
  }

  embedQuery(text: string): Promise<number[]> {
    return this.getEmbeddings().embedQuery(text);
  }

  toVectorLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
  }
}
