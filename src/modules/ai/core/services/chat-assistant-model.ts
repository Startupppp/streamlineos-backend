import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { google } from "@ai-sdk/google";
import { type LanguageModel } from "ai";

const DEFAULT_GOOGLE_CHAT_MODEL = "gemini-2.5-pro";
const DEFAULT_OPENROUTER_CHAT_MODEL = "openai/gpt-4o";

export const CHAT_FEATURE = "chat.message";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatContext {
  todayAttendance: {
    checkedIn: boolean;
    checkedOut: boolean;
    workHours: string | null;
  } | null;
  pendingLeaves: number;
  recentPayrolls: Array<{ month: string; status: string }>;
  myLeadsCount: number;
  myOpenDealsCount: number;
  topLeads: Array<{ name: string; status: string; priority: string | null }>;
}

export function resolveChatModelId(): string {
  const override = process.env.AI_CHAT_MODEL?.trim();
  if (override) return override;
  if (process.env.AI_CHAT_PROVIDER === "openrouter") {
    return DEFAULT_OPENROUTER_CHAT_MODEL;
  }
  return DEFAULT_GOOGLE_CHAT_MODEL;
}

export function resolveChatModel(): LanguageModel {
  const modelId = resolveChatModelId();
  if (process.env.AI_CHAT_PROVIDER === "openrouter") {
    return createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY }).chat(modelId);
  }
  return google(modelId);
}
