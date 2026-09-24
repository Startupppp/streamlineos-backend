import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { ASK_OS_TOOLS_KEY } from "./ask-os-tools.decorator";
import { ASK_OS_TOOL_PROVIDERS } from "./ask-os-tool-providers";
import type { AskOsToolProvider } from "./ask-os-tool.types";

function isToolProvider(instance: unknown): instance is AskOsToolProvider {
  if (typeof instance !== "object" || instance === null) return false;
  if (!("tools" in instance)) return false;
  const { tools } = instance;
  return typeof tools === "function";
}

@Injectable()
export class AskOsToolDiscoveryService implements OnModuleInit {
  private readonly registry: AskOsToolProvider[];

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(ASK_OS_TOOL_PROVIDERS) registry: AskOsToolProvider[],
  ) {
    this.registry = registry;
  }

  onModuleInit(): void {
    const found = this.discovery
      .getProviders()
      .filter(
        (wrapper) =>
          wrapper.metatype !== null &&
          wrapper.metatype !== undefined &&
          Reflect.getMetadata(ASK_OS_TOOLS_KEY, wrapper.metatype) === true,
      )
      .map((wrapper) => wrapper.instance)
      .filter(isToolProvider);

    if (found.length === 0)
      throw new Error(
        "Ask OS tool discovery found zero providers — ensure at least one class carries @AskOsTools() and is listed in providers[]",
      );

    this.registry.push(...found);
  }
}
