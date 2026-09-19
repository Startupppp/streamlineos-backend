import type { AskOsToolDefinition, AskOsToolProvider } from "./ask-os-tool.types";

export const ASK_OS_TOOL_PROVIDERS = Symbol("ASK_OS_TOOL_PROVIDERS");

export function collectToolDefinitions(
  providers: readonly AskOsToolProvider[],
): AskOsToolDefinition[] {
  return providers.flatMap((provider) => provider.tools());
}
