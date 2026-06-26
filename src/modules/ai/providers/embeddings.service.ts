import { Injectable } from "@nestjs/common";
import { OpenAIEmbeddings } from "@langchain/openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

@Injectable()
export class EmbeddingsService {
  private embeddings: OpenAIEmbeddings | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  private getEmbeddings(): OpenAIEmbeddings {
    if (this.embeddings) return this.embeddings;
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    this.embeddings = new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_API_KEY,
      model: EMBEDDING_MODEL,
    });
    return this.embeddings;
  }

  embedQuery(text: string): Promise<number[]> {
    return this.getEmbeddings().embedQuery(text);
  }

  toVectorLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
  }
}
