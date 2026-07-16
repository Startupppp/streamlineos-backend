import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";
import { resolveLlmProvider, type LlmProviderConfig } from "./llm-provider.config";

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

@Injectable()
export class LlmService {
  private readonly config: LlmProviderConfig = resolveLlmProvider();
  private fastModel: ChatOpenAI | null = null;
  private standardModel: ChatOpenAI | null = null;

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  private buildModel(model: string, temperature: number, timeout: number): ChatOpenAI {
    if (!this.config.apiKey) throw new Error(`${this.config.provider} API key is not set`);
    return new ChatOpenAI({
      apiKey: this.config.apiKey,
      model,
      temperature,
      timeout,
      maxRetries: 2,
      ...(this.config.baseURL ? { configuration: { baseURL: this.config.baseURL } } : {}),
    });
  }

  private getFastModel(): ChatOpenAI {
    if (!this.fastModel) this.fastModel = this.buildModel(this.config.fastModel, 0.3, 30000);
    return this.fastModel;
  }

  private getStandardModel(): ChatOpenAI {
    if (!this.standardModel) this.standardModel = this.buildModel(this.config.standardModel, 0.3, 60000);
    return this.standardModel;
  }

  private modelFor(tier: ModelTier | undefined): ChatOpenAI {
    return tier === "standard" ? this.getStandardModel() : this.getFastModel();
  }

  private async run<R>(fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("api key") || message.includes("401") || message.includes("authentication")) {
        throw new ServiceUnavailableException("AI provider is not configured correctly");
      }
      throw new ServiceUnavailableException("AI provider is temporarily unavailable");
    }
  }

  async invokeStructured<T extends z.ZodTypeAny>(opts: InvokeOptions<T>): Promise<z.infer<T>> {
    const structured = this.modelFor(opts.model).withStructuredOutput(opts.schema, {
      name: opts.schemaName,
      method: "jsonSchema",
      strict: true,
    });
    const result = await this.run(() =>
      structured.invoke([
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ]),
    );
    return opts.schema.parse(result);
  }

  async invokeStructuredWithImage<T extends z.ZodTypeAny>(opts: InvokeWithImageOptions<T>): Promise<z.infer<T>> {
    if (opts.images.length === 0) return this.invokeStructured(opts);

    const structured = this.modelFor(opts.model).withStructuredOutput(opts.schema, {
      name: opts.schemaName,
      method: "jsonSchema",
      strict: true,
    });

    const imageBlocks = opts.images.map((dataUrl) => {
      const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
      if (!match) return { type: "image_url" as const, image_url: { url: dataUrl } };
      const [, mimeType, data] = match;
      return { type: "image_url" as const, image_url: { url: `data:${mimeType};base64,${data}` } };
    });

    const humanContent = [{ type: "text" as const, text: opts.user }, ...imageBlocks];

    const result = await this.run(() =>
      structured.invoke([new SystemMessage(opts.system), new HumanMessage({ content: humanContent })]),
    );
    return opts.schema.parse(result);
  }

  async invokeText(opts: TextOptions): Promise<string> {
    const model =
      opts.temperature !== undefined
        ? this.buildModel(
            opts.model === "standard" ? this.config.standardModel : this.config.fastModel,
            opts.temperature,
            30000,
          )
        : this.modelFor(opts.model);

    const result = await this.run(() =>
      model.invoke([
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ]),
    );

    return typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  }

  async invokeJson<T>(opts: JsonOptions): Promise<T> {
    const result = await this.run(() =>
      this.modelFor(opts.model).invoke([
        { role: "system", content: `${opts.system}\n\nRespond with valid JSON only.` },
        { role: "user", content: opts.user },
      ]),
    );
    const text = typeof result.content === "string" ? result.content : "";
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned) as T;
  }

  private buildModelWithMaxTokens(tier: ModelTier | undefined, temperature: number, maxTokens: number | undefined): ChatOpenAI {
    const modelId = tier === "standard" ? this.config.standardModel : this.config.fastModel;
    const timeout = tier === "standard" ? 60000 : 30000;
    if (!this.config.apiKey) throw new Error(`${this.config.provider} API key is not set`);
    return new ChatOpenAI({
      apiKey: this.config.apiKey,
      model: modelId,
      temperature,
      timeout,
      maxRetries: 2,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(this.config.baseURL ? { configuration: { baseURL: this.config.baseURL } } : {}),
    });
  }

  async invokeTextWithUsage(opts: TextOptions & { maxTokens?: number }): Promise<LlmTextResult> {
    const modelName = opts.model === "standard" ? this.config.standardModel : this.config.fastModel;
    const temperature = opts.temperature ?? 0.3;
    const model = opts.maxTokens !== undefined
      ? this.buildModelWithMaxTokens(opts.model, temperature, opts.maxTokens)
      : opts.temperature !== undefined
        ? this.buildModel(modelName, temperature, 30000)
        : this.modelFor(opts.model);
    const result = await this.run(() =>
      model.invoke([
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ]),
    );
    const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    return { text, usage: extractUsage(result.usage_metadata), model: modelName };
  }

  async invokeStructuredWithUsage<T extends z.ZodTypeAny>(
    opts: InvokeOptions<T> & { maxTokens?: number },
  ): Promise<LlmStructuredResult<z.infer<T>>> {
    const modelName = opts.model === "standard" ? this.config.standardModel : this.config.fastModel;
    const base = opts.maxTokens !== undefined
      ? this.buildModelWithMaxTokens(opts.model, 0.3, opts.maxTokens)
      : this.modelFor(opts.model);
    const structured = base.withStructuredOutput(opts.schema, {
      name: opts.schemaName,
      method: "jsonSchema",
      strict: true,
      includeRaw: true,
    });
    const result = await this.run(() =>
      structured.invoke([
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ]),
    );
    const parsed: z.infer<T> = opts.schema.parse(result.parsed);
    const aiMsg = AIMessage.isInstance(result.raw) ? result.raw : null;
    const usageMeta = aiMsg?.usage_metadata ?? null;
    return { data: parsed, usage: extractUsage(usageMeta), model: modelName };
  }
}
