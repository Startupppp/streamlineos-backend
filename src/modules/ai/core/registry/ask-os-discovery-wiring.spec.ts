import { DiscoveryModule } from "@nestjs/core";
import { AiModule } from "../ai.module";
import { AskOsToolDiscoveryService } from "./ask-os-tool-discovery.service";

function metadata(key: string): unknown[] {
  const value: unknown = Reflect.getMetadata(key, AiModule);
  return Array.isArray(value) ? value : [];
}

describe("a module that discovers tool providers imports the module that supplies the discoverer", () => {
  it("registers the discovery service, so the assertions below are about a provider that really exists", () => {
    expect(metadata("providers")).toContain(AskOsToolDiscoveryService);
  });

  it("imports DiscoveryModule, because DiscoveryService is not global and Nest cannot construct AiModule without it", () => {
    expect(metadata("imports")).toContain(DiscoveryModule);
  });
});
