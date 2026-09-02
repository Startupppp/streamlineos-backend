import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";
import { logger } from "../../../../common/logger/logger.service";
import { resolveLlmProvider, type LlmProviderConfig } from "./llm-provider.config";
import {
  backoffDelayMs,
  classifyLlmError,
  isAuthError,
  resolveLlmRetryPolicy,
  type LlmRetryPolicy,
} from "./llm-retry";

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface LlmTextResult {
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmStructuredResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
}

interface UsageMeta {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function extractUsage(meta: UsageMeta | null | undefined): LlmUsage {
  if (!meta) return { promptTokens: null, completionTokens: null, totalTokens: null };
  return {
    promptTokens: meta.input_tokens,
    completionTokens: meta.output_tokens,
    totalTokens: meta.total_tokens,
  };
}

type ModelTier = "fast" | "standard";

interface InvokeOptions<T extends z.ZodTypeAny> {
  model?: ModelTier;
  schema: T;
  schemaName: string;
  system: string;
  user: string;
}

interface InvokeWithImageOptions<T extends z.ZodTypeAny> extends InvokeOptions<T> {
  images: string[];
}

interface TextOptions {
  model?: ModelTier;
  system: string;
  user: string;
  temperature?: number;
}

interface JsonOptions {
  model?: ModelTier;
  system: string;
  user: string;
}

interface ModelSpec {
  temperature: number;
  timeoutMs: number;
  maxTokens?: number;
}

interface Attempted<R> {
  result: R;
  model: string;
}

type CallOptions = { signal?: AbortSignal };

/**
 * Called once per provider attempt beyond the first, across both backoff retries
 * and model fallback. Retries are otherwise invisible above this class: they are
 * folded into one latency number, so a call that answered on its third attempt
 * reads as a single slow provider rather than two failures and a recovery.
 */
type RetryObserver = () => void;

function callConfig(signal: AbortSignal | undefined): CallOptions {
  return signal === undefined ? {} : { signal };
}

const FAST_TIMEOUT_MS = 30_000;
const STANDARD_TIMEOUT_MS = 60_000;

function toImageBlocks(images: string[]) {
  return images.map((dataUrl) => {
    const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
    if (!match) return { type: "image_url" as const, image_url: { url: dataUrl } };
    const [, mimeType, data] = match;
    return { type: "image_url" as const, image_url: { url: `data:${mimeType};base64,${data}` } };
  });
}

@Injectable()
export class LlmService {
  private readonly config: LlmProviderConfig = resolveLlmProvider();
  private readonly policy: LlmRetryPolicy = resolveLlmRetryPolicy();
  private readonly models = new Map<string, ChatOpenAI>();

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  private chainFor(tier: ModelTier | undefined): string[] {
    return tier === "standard" ? this.config.standardChain : this.config.fastChain;
  }

  private specFor(tier: ModelTier | undefined, overrides: Partial<ModelSpec> = {}): ModelSpec {
    return {
      temperature: overrides.temperature ?? 0.3,
      timeoutMs: overrides.timeoutMs ?? (tier === "standard" ? STANDARD_TIMEOUT_MS : FAST_TIMEOUT_MS),
      ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
    };
  }

  private model(modelId: string, spec: ModelSpec): ChatOpenAI {
    if (!this.config.apiKey) throw new Error(`${this.config.provider} API key is not set`);

    const key = `${modelId}|${String(spec.temperature)}|${String(spec.timeoutMs)}|${String(spec.maxTokens ?? "")}`;
    const cached = this.models.get(key);
    if (cached) return cached;

    const built = new ChatOpenAI({
      apiKey: this.config.apiKey,
      model: modelId,
      temperature: spec.temperature,
      timeout: spec.timeoutMs,
      // Retries and model fallback are owned here, so the client must not add its own.
      maxRetries: 0,
      ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
      ...(this.config.baseURL ? { configuration: { baseURL: this.config.baseURL } } : {}),
    });
    this.models.set(key, built);
    return built;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Retries each model in the tier's chain with jittered backoff, then falls
   * through to the next model. Returns the model that actually answered, because
   * credits are metered per model and a fallback bills at a different rate.
   */
  private async attempt<R>(
    tier: ModelTier | undefined,
    invoke: (model: ChatOpenAI, modelId: string) => Promise<R>,
    spec: ModelSpec,
    signal?: AbortSignal,
    onRetry?: RetryObserver,
  ): Promise<Attempted<R>> {
    const chain = this.chainFor(tier);
    let lastError: unknown = new Error("AI provider produced no result");
    let first = true;

    for (const modelId of chain) {
      for (let attempt = 0; attempt <= this.policy.maxRetriesPerModel; attempt += 1) {
        signal?.throwIfAborted();
        if (!first) onRetry?.();
        first = false;
        try {
          const result = await invoke(this.model(modelId, spec), modelId);
          return { result, model: modelId };
        } catch (error: unknown) {
          lastError = error;
          if (signal?.aborted) throw error;
          const kind = classifyLlmError(error);

          if (kind === "fatal") throw this.toServiceError(error);

          if (attempt < this.policy.maxRetriesPerModel) {
            const delay = backoffDelayMs(attempt, error, this.policy);
            logger.warn("AI provider call failed — retrying", {
              model: modelId,
              kind,
              attempt: attempt + 1,
              delayMs: delay,
            });
            await this.sleep(delay);
            continue;
          }

          logger.warn("AI model exhausted its retries", { model: modelId, kind });
        }
      }
    }

    throw this.toServiceError(lastError);
  }

  private toServiceError(error: unknown): ServiceUnavailableException {
    if (isAuthError(error))
      return new ServiceUnavailableException("AI provider is not configured correctly");
    return new ServiceUnavailableException("AI provider is temporarily unavailable");
  }

  private structured<T extends z.ZodTypeAny>(
    model: ChatOpenAI,
    opts: InvokeOptions<T>,
    includeRaw: boolean,
  ) {
    return model.withStructuredOutput(opts.schema, {
      name: opts.schemaName,
      method: "jsonSchema",
      strict: true,
      ...(includeRaw ? { includeRaw: true } : {}),
    });
  }

  async invokeStructured<T extends z.ZodTypeAny>(opts: InvokeOptions<T>): Promise<z.infer<T>> {
    const { result } = await this.attempt(
      opts.model,
      (model) =>
        this.structured(model, opts, false).invoke([
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ]),
      this.specFor(opts.model),
    );
    return opts.schema.parse(result);
  }

  async invokeStructuredWithImage<T extends z.ZodTypeAny>(
    opts: InvokeWithImageOptions<T>,
  ): Promise<z.infer<T>> {
    if (opts.images.length === 0) return this.invokeStructured(opts);

    const humanContent = [{ type: "text" as const, text: opts.user }, ...toImageBlocks(opts.images)];
    const { result } = await this.attempt(
      opts.model,
      (model) =>
        this.structured(model, opts, false).invoke([
          new SystemMessage(opts.system),
          new HumanMessage({ content: humanContent }),
        ]),
      this.specFor(opts.model),
    );
    return opts.schema.parse(result);
  }

  async invokeText(opts: TextOptions): Promise<string> {
    const { result } = await this.attempt(
      opts.model,
      (model) =>
        model.invoke([
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ]),
      this.specFor(opts.model, { temperature: opts.temperature ?? 0.3 }),
    );
    return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  }

  async invokeJson<T>(opts: JsonOptions): Promise<T> {
    const { result } = await this.attempt(
      opts.model,
      (model) =>
        model.invoke([
          { role: "system", content: `${opts.system}\n\nRespond with valid JSON only.` },
          { role: "user", content: opts.user },
        ]),
      this.specFor(opts.model),
    );
    const text = typeof result.content === "string" ? result.content : "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned) as T;
  }

  async invokeTextWithUsage(
    opts: TextOptions & { maxTokens?: number; signal?: AbortSignal; onRetry?: RetryObserver },
  ): Promise<LlmTextResult> {
    const { result, model } = await this.attempt(
      opts.model,
      (client) =>
        client.invoke(
          [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          callConfig(opts.signal),
        ),
      this.specFor(opts.model, {
        temperature: opts.temperature ?? 0.3,
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      }),
      opts.signal,
      opts.onRetry,
    );

    const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    return { text, usage: extractUsage(result.usage_metadata), model };
  }

  async invokeStructuredWithUsage<T extends z.ZodTypeAny>(
    opts: InvokeOptions<T> & { maxTokens?: number; signal?: AbortSignal; onRetry?: RetryObserver },
  ): Promise<LlmStructuredResult<z.infer<T>>> {
    const { result, model } = await this.attempt(
      opts.model,
      (client) =>
        this.structured(client, opts, true).invoke(
          [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          callConfig(opts.signal),
        ),
      this.specFor(opts.model, opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      opts.signal,
      opts.onRetry,
    );

    const parsed: z.infer<T> = opts.schema.parse(result.parsed);
    const aiMsg = AIMessage.isInstance(result.raw) ? result.raw : null;
    return { data: parsed, usage: extractUsage(aiMsg?.usage_metadata ?? null), model };
  }

  async invokeStructuredWithImageWithUsage<T extends z.ZodTypeAny>(
    opts: InvokeWithImageOptions<T> & { maxTokens?: number; signal?: AbortSignal; onRetry?: RetryObserver },
  ): Promise<LlmStructuredResult<z.infer<T>>> {
    if (opts.images.length === 0) return this.invokeStructuredWithUsage(opts);

    const humanContent = [{ type: "text" as const, text: opts.user }, ...toImageBlocks(opts.images)];
    const { result, model } = await this.attempt(
      opts.model,
      (client) =>
        this.structured(client, opts, true).invoke(
          [
            new SystemMessage(opts.system),
            new HumanMessage({ content: humanContent }),
          ],
          callConfig(opts.signal),
        ),
      this.specFor(opts.model, opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      opts.signal,
      opts.onRetry,
    );

    const parsed: z.infer<T> = opts.schema.parse(result.parsed);
    const aiMsg = AIMessage.isInstance(result.raw) ? result.raw : null;
    return { data: parsed, usage: extractUsage(aiMsg?.usage_metadata ?? null), model };
  }
}
