import { Injectable } from "@nestjs/common";
import { OpenAIEmbeddings } from "@langchain/openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_TIMEOUT_MS = 20_000;
const MAX_EMBED_BATCH = 64;

/**
 * LangChain's `Embeddings.embedQuery` takes no per-call options and
 * `OpenAIEmbeddings.embeddingWithRetry` hardcodes `requestOptions = {}`, so the
 * signal cannot reach the embedding HTTP request itself. What it can do is stop
 * the caller waiting on a dead client, which is what releases the reservation
 * and prevents the far more expensive completion leg from ever being dispatched.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

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

  async embedQueryRaw(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    return abortable(this.getEmbeddings().embedQuery(text), signal);
  }

  async embedBatchRaw(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = this.getEmbeddings();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_EMBED_BATCH) {
      signal?.throwIfAborted();
      out.push(
        ...(await abortable(client.embedDocuments(texts.slice(i, i + MAX_EMBED_BATCH)), signal)),
      );
    }
    return out;
  }

  toVectorLiteral(vec: number[]): string {
    return `[${vec.join(",")}]`;
  }
}
