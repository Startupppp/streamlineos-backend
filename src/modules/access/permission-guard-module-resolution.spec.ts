import { Controller, Get, Global, Injectable, Module, UseGuards } from "@nestjs/common";
import { DiscoveryModule, MetadataScanner } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { RateLimitModule } from "../../common/ratelimit/rate-limit.module";
import { AccessModule } from "./access.module";
import { AccessService } from "./access.service";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./require-permission.decorator";

@Injectable()
class MetadataScannerConsumer {
  constructor(private readonly scanner: MetadataScanner) {}

  names(prototype: object): string[] {
    return this.scanner.getAllMethodNames(prototype);
  }
}

@Controller("resolution-probe")
@UseGuards(PermissionGuard)
class ResolutionProbeController {
  @Get()
  @RequirePermission("build:tickets:view")
  read(): string {
    return "ok";
  }
}

@Module({ controllers: [ResolutionProbeController] })
class ConsumerModule {}

const accessStub = { hasPermission: (): boolean => true };

function globalAccessModule(exportDiscovery: boolean): unknown {
  @Global()
  @Module({
    imports: [DiscoveryModule],
    providers: [PermissionGuard, { provide: AccessService, useValue: accessStub }],
    exports: exportDiscovery
      ? [DiscoveryModule, PermissionGuard, AccessService]
      : [PermissionGuard, AccessService],
  })
  class StandInAccessModule {}
  return StandInAccessModule;
}

describe("PermissionGuard module resolution", () => {
  it("fails to compile a consumer module when the global access module does not export DiscoveryModule, because Nest builds a controller's @UseGuards class in the host module's injector rather than reusing the exported provider", async () => {
    const builder = Test.createTestingModule({
      imports: [globalAccessModule(false), ConsumerModule],
    });

    await expect(builder.compile()).rejects.toThrow(/DiscoveryService/);
  });

  it("compiles the same consumer module once the global access module exports DiscoveryModule", async () => {
    const builder = Test.createTestingModule({
      imports: [globalAccessModule(true), ConsumerModule],
    });

    const moduleRef = await builder.compile();

    expect(moduleRef.get(PermissionGuard, { strict: false })).toBeInstanceOf(PermissionGuard);
    await moduleRef.close();
  });

  it("exports DiscoveryModule from AccessModule, so every module whose controller mounts PermissionGuard can construct it without importing DiscoveryModule itself", () => {
    const exports: unknown = Reflect.getMetadata("exports", AccessModule);

    expect(Array.isArray(exports)).toBe(true);
    expect(exports).toContain(DiscoveryModule);
  });

  it("exports DiscoveryModule from RateLimitModule too, because RateLimitGuard takes the same two constructor params and must not depend on AccessModule's export to resolve", () => {
    const exports: unknown = Reflect.getMetadata("exports", RateLimitModule);

    expect(Array.isArray(exports)).toBe(true);
    expect(exports).toContain(DiscoveryModule);
  });

  it("cannot resolve MetadataScanner from Nest's global internal core module, which is why exporting DiscoveryModule is the fix that covers both injected params", async () => {
    @Module({ providers: [MetadataScannerConsumer] })
    class WithoutDiscoveryModule {}

    await expect(
      Test.createTestingModule({ imports: [WithoutDiscoveryModule] }).compile(),
    ).rejects.toThrow(/MetadataScanner/);

    @Module({ imports: [DiscoveryModule], providers: [MetadataScannerConsumer] })
    class WithDiscoveryModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [WithDiscoveryModule],
    }).compile();

    expect(moduleRef.get(MetadataScannerConsumer)).toBeInstanceOf(MetadataScannerConsumer);
    await moduleRef.close();
  });
});
