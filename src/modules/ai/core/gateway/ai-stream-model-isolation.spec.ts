import {
  DEFAULT_STREAM_GOOGLE_MODEL,
  DEFAULT_STREAM_OPENROUTER_MODEL,
  resolveDefaultStreamModelId,
} from "./ai-stream-model";
import { resolveChatModelId } from "../services/chat-assistant-model";
import { computeTokenCharge } from "../billing/ai-model-pricing.constants";

describe("the untiered stream default is independent of the chat model", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("does not follow AI_CHAT_MODEL, so changing chat cannot repoint the 21 untiered callers", () => {
    process.env.AI_CHAT_MODEL = "some-brand-new-model";
    expect(resolveChatModelId()).toBe("some-brand-new-model");
    expect(resolveDefaultStreamModelId()).toBe(DEFAULT_STREAM_GOOGLE_MODEL);
  });

  it("holds the untiered default at the value it had before the chat model was upgraded", () => {
    delete process.env.AI_CHAT_PROVIDER;
    expect(resolveDefaultStreamModelId()).toBe("gemini-1.5-pro-latest");
    process.env.AI_CHAT_PROVIDER = "openrouter";
    expect(resolveDefaultStreamModelId()).toBe(DEFAULT_STREAM_OPENROUTER_MODEL);
  });

  it("upgrades the chat default while the stream default stays put", () => {
    delete process.env.AI_CHAT_MODEL;
    delete process.env.AI_CHAT_PROVIDER;
    expect(resolveChatModelId()).toBe("gemini-2.5-pro");
    expect(resolveDefaultStreamModelId()).not.toBe(resolveChatModelId());
  });
});

describe("every model this deployment can select is priced", () => {
  const priced = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-pro-latest",
    "openai/gpt-4o",
  ];

  it.each(priced)("prices %s above the unknown-model fallback floor", (model) => {
    const unknown = computeTokenCharge("a-model-nobody-priced", 1_000_000, 1_000_000);
    const actual = computeTokenCharge(model, 1_000_000, 1_000_000);
    expect(actual.costUsd).not.toBe(unknown.costUsd);
  });

  it("would have mis-metered the upgraded chat model before its pricing row existed", () => {
    const fallback = computeTokenCharge("a-model-nobody-priced", 1_000_000, 1_000_000);
    const upgraded = computeTokenCharge("gemini-2.5-pro", 1_000_000, 1_000_000);
    expect(upgraded.costUsd).toBeGreaterThan(fallback.costUsd);
  });
});
