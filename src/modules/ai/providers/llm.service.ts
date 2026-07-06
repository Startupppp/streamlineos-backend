import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import type { z } from "zod";
import { resolveLlmProvider, type LlmProviderConfig } from "./llm-provider.config";

type ModelTier = "fast" | "standard";

interface InvokeOptions<T extends z.ZodTypeAny> {
  model?: ModelTier;
  schema: T;
  schemaName: string;
  system: string;
  user: string;
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
}
