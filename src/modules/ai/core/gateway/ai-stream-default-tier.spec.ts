import {
  DEFAULT_STREAM_GOOGLE_MODEL,
  DEFAULT_STREAM_OPENROUTER_MODEL,
} from "./ai-stream-model";
import { AI_MODEL_CATALOG } from "../billing/ai-model-pricing.constants";

function bareModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash === -1 ? modelId : modelId.slice(slash + 1);
}

describe("the streaming default model is a deliberate choice, not whichever string was typed last", () => {
  it("bills at its own rate, because a default with no catalog entry silently bills at DEFAULT behind a logger.warn", () => {
    for (const modelId of [DEFAULT_STREAM_GOOGLE_MODEL, DEFAULT_STREAM_OPENROUTER_MODEL])
      expect(Object.keys(AI_MODEL_CATALOG)).toContain(bareModelId(modelId));
  });

  it("stays on the standard-quality model rather than drifting down to the buffered fast default, which was decided for the 15 streaming callers that pass no tier", () => {
    expect(DEFAULT_STREAM_GOOGLE_MODEL).toBe("gemini-1.5-pro-latest");
    expect(DEFAULT_STREAM_OPENROUTER_MODEL).toBe("openai/gpt-4o");
  });
});
