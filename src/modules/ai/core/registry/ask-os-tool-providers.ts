import type { AskOsToolDefinition, AskOsToolProvider } from "./ask-os-tool.types";

export const ASK_OS_TOOL_PROVIDERS = Symbol("ASK_OS_TOOL_PROVIDERS");

const definitionsByProvider = new WeakMap<AskOsToolProvider, AskOsToolDefinition[]>();

export function collectToolDefinitions(
  providers: readonly AskOsToolProvider[],
): AskOsToolDefinition[] {
  return providers.flatMap((provider) => {
    const cached = definitionsByProvider.get(provider);
    if (cached !== undefined) return cached;
    const built = provider.tools();
    definitionsByProvider.set(provider, built);
    return built;
  });
}
