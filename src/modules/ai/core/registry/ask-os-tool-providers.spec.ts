import { z } from "zod";
import { collectToolDefinitions } from "./ask-os-tool-providers";
import { manifestSchema } from "./ask-os-tool-manifest";
import { data, defineTool } from "./ask-os-tool.types";
import type { AskOsToolProvider } from "./ask-os-tool.types";

function provider(key: string): AskOsToolProvider & { calls: number } {
  return {
    calls: 0,
    tools() {
      this.calls += 1;
      return [
        defineTool({
          key,
          description: key,
          input: z.object({ query: z.string() }),
          run: async () => data({ ok: true }),
        }),
      ];
    },
  };
}

describe("a provider builds its tool definitions once for the process, not once per chat turn", () => {
  it("calls tools() a single time across repeated turns, because building 62 definitions per request is work no turn needs", () => {
    const one = provider("alpha");

    collectToolDefinitions([one]);
    collectToolDefinitions([one]);
    collectToolDefinitions([one]);

    expect(one.calls).toBe(1);
  });

  it("returns the same definition objects each turn, which is what lets the manifest memo on those objects ever hit", () => {
    const one = provider("alpha");

    const first = collectToolDefinitions([one]);
    const second = collectToolDefinitions([one]);

    expect(first[0]).toBe(second[0]);
    expect(manifestSchema(first[0]!)).toBe(manifestSchema(second[0]!));
  });

  it("keeps every provider's tools, so caching never silently drops a module from the manifest", () => {
    const keys = collectToolDefinitions([provider("alpha"), provider("beta")]).map(
      (definition) => definition.key,
    );

    expect(keys).toEqual(["alpha", "beta"]);
  });
});
