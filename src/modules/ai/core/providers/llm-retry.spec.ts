import {
  backoffDelayMs,
  classifyLlmError,
  isAuthError,
  retryAfterMs,
  DEFAULT_LLM_RETRY_POLICY,
} from "./llm-retry";
import { resolveLlmProvider } from "./llm-provider.config";

describe("classifyLlmError", () => {
  it("treats 429 as a rate limit regardless of message", () => {
    expect(classifyLlmError({ status: 429 })).toBe("rate_limit");
    expect(classifyLlmError(new Error("Rate limit reached for gpt-4o"))).toBe("rate_limit");
    expect(classifyLlmError(new Error("You exceeded your current quota"))).toBe("rate_limit");
  });

  it("treats 503 and capacity language as overloaded", () => {
    expect(classifyLlmError({ status: 503 })).toBe("overloaded");
    expect(classifyLlmError(new Error("The engine is currently overloaded"))).toBe("overloaded");
  });

  it("treats timeouts and 5xx as transient", () => {
    expect(classifyLlmError({ status: 500 })).toBe("transient");
    expect(classifyLlmError({ status: 502 })).toBe("transient");
    expect(classifyLlmError(new Error("socket hang up"))).toBe("transient");
    expect(classifyLlmError(new Error("ETIMEDOUT"))).toBe("transient");
  });

  it("treats auth and malformed-request failures as fatal, because a fallback model fails identically", () => {
    expect(classifyLlmError({ status: 401 })).toBe("fatal");
    expect(classifyLlmError({ status: 403 })).toBe("fatal");
    expect(classifyLlmError({ status: 400 })).toBe("fatal");
    expect(classifyLlmError(new Error("Incorrect API key provided"))).toBe("fatal");
    expect(classifyLlmError(new Error("maximum context length is 8192 tokens"))).toBe("fatal");
  });

  it("reads the status through a wrapped cause chain", () => {
    expect(classifyLlmError(Object.assign(new Error("wrapped"), { cause: { status: 429 } }))).toBe(
      "rate_limit",
    );
  });

  it("defaults an unrecognised failure to transient so a blip still gets one more chance", () => {
    expect(classifyLlmError(new Error("something odd"))).toBe("transient");
  });
});

describe("isAuthError", () => {
  it("separates misconfiguration from ordinary unavailability", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError(new Error("Incorrect API key provided"))).toBe(true);
    expect(isAuthError({ status: 429 })).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("honours a provider Retry-After in seconds", () => {
    expect(retryAfterMs({ headers: { "retry-after": "2" } })).toBe(2000);
  });

  it("honours retry-after-ms verbatim", () => {
    expect(retryAfterMs({ headers: { "retry-after-ms": "250" } })).toBe(250);
  });

  it("returns null when absent", () => {
    expect(retryAfterMs(new Error("nope"))).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and stays within the cap", () => {
    const noJitter = () => 0.5;
    expect(backoffDelayMs(0, null, DEFAULT_LLM_RETRY_POLICY, noJitter)).toBe(500);
    expect(backoffDelayMs(1, null, DEFAULT_LLM_RETRY_POLICY, noJitter)).toBe(1000);
    expect(backoffDelayMs(9, null, DEFAULT_LLM_RETRY_POLICY, noJitter)).toBe(
      DEFAULT_LLM_RETRY_POLICY.maxDelayMs,
    );
  });

  it("prefers the provider's Retry-After over the computed backoff", () => {
    expect(backoffDelayMs(0, { headers: { "retry-after": "3" } })).toBe(3000);
  });

  it("caps an unreasonable Retry-After", () => {
    expect(backoffDelayMs(0, { headers: { "retry-after": "3600" } })).toBe(
      DEFAULT_LLM_RETRY_POLICY.maxDelayMs,
    );
  });

  it("never returns a negative delay under maximum negative jitter", () => {
    expect(backoffDelayMs(0, null, DEFAULT_LLM_RETRY_POLICY, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveLlmProvider fallback chains", () => {
  it("falls back to the other tier's configured model rather than a guessed id", () => {
    const config = resolveLlmProvider({ OPENAI_API_KEY: "k" });
    expect(config.fastChain).toEqual(["gpt-4o-mini", "gpt-4o"]);
    expect(config.standardChain).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("uses an explicit override chain when provided", () => {
    const config = resolveLlmProvider({
      OPENAI_API_KEY: "k",
      AI_FAST_FALLBACK_MODELS: "gpt-4o, gpt-3.5-turbo",
    });
    expect(config.fastChain).toEqual(["gpt-4o-mini", "gpt-4o", "gpt-3.5-turbo"]);
  });

  it("never repeats a model in a chain", () => {
    const config = resolveLlmProvider({
      OPENAI_API_KEY: "k",
      AI_FAST_FALLBACK_MODELS: "gpt-4o-mini,gpt-4o",
    });
    expect(config.fastChain).toEqual(["gpt-4o-mini", "gpt-4o"]);
  });

  it("keeps openrouter model ids namespaced", () => {
    const config = resolveLlmProvider({ AI_LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" });
    expect(config.fastChain).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o"]);
  });
});
