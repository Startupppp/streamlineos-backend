import { Controller, Get, Global, Module, UseGuards } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AccessModule } from "./access.module";
import { AccessService } from "./access.service";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./require-permission.decorator";

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
});
