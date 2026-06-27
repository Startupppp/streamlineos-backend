import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import type { z } from "zod";

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
  private fastModel: ChatOpenAI | null = null;
  private standardModel: ChatOpenAI | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  private getFastModel(): ChatOpenAI {
    if (this.fastModel) return this.fastModel;
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    this.fastModel = new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-4o-mini",
      temperature: 0.3,
      timeout: 30000,
      maxRetries: 2,
    });
    return this.fastModel;
  }

  private getStandardModel(): ChatOpenAI {
    if (this.standardModel) return this.standardModel;
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    this.standardModel = new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      model: "gpt-4o",
      temperature: 0.3,
      timeout: 60000,
      maxRetries: 2,
    });
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
        ? new ChatOpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            model: opts.model === "standard" ? "gpt-4o" : "gpt-4o-mini",
            temperature: opts.temperature,
            timeout: 30000,
            maxRetries: 2,
          })
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
