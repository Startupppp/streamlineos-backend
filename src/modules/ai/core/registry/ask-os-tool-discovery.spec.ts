import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { z } from "zod";
import { AskOsTools } from "./ask-os-tools.decorator";
import { AskOsToolDiscoveryService } from "./ask-os-tool-discovery.service";
import { ASK_OS_TOOL_PROVIDERS } from "./ask-os-tool-providers";
import { defineTool, data, type AskOsToolDefinition, type AskOsToolProvider } from "./ask-os-tool.types";

@AskOsTools()
@Injectable()
class DecoratedProvider implements AskOsToolProvider {
  tools(): AskOsToolDefinition[] {
    return [
      defineTool({
        key: "test-decorated",
        description: "d",
        input: z.object({}),
        run: async () => data({}),
      }),
    ];
  }
}

@Injectable()
class UndecoratedProvider implements AskOsToolProvider {
  tools(): AskOsToolDefinition[] {
    return [];
  }
}

describe("the decorator replaces the static list as the sole registration signal for tool providers", () => {
  it("a class carrying @AskOsTools() is discovered and an undecorated one is not, so omitting the decorator is the only way to exclude a class", async () => {
    const registry: AskOsToolProvider[] = [];
    const module = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        { provide: ASK_OS_TOOL_PROVIDERS, useValue: registry },
        AskOsToolDiscoveryService,
        DecoratedProvider,
        UndecoratedProvider,
      ],
    }).compile();

    await module.init();

    const decoratedInstance = module.get(DecoratedProvider);
    const undecoratedInstance = module.get(UndecoratedProvider);

    expect(registry).toContain(decoratedInstance);
    expect(registry).not.toContain(undecoratedInstance);
    expect(registry).toHaveLength(1);
  });
});
