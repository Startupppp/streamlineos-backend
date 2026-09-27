import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { UseGuards } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "./permission.guard";
import { RequirePermission } from "./require-permission.decorator";

function makeScanner(): MetadataScanner {
  return {
    getAllMethodNames: (proto: object): string[] => {
      const names: string[] = [];
      let p: object | null = proto;
      while (p && p !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(p)) {
          if (name !== "constructor" && !names.includes(name)) names.push(name);
        }
        p = Object.getPrototypeOf(p) as object | null;
      }
      return names;
    },
  } as unknown as MetadataScanner;
}

function makeDiscovery(instances: object[]): DiscoveryService {
  return {
    getControllers: () => instances.map((instance) => ({ instance })),
  } as unknown as DiscoveryService;
}

function makeGuard(instances: object[]): PermissionGuard {
  const reflector = new Reflector();
  const access = {} as never;
  return new PermissionGuard(reflector, access, makeDiscovery(instances), makeScanner());
}

class BrokenController {
  route(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "/broken", BrokenController.prototype.route);
Reflect.defineMetadata("require_permission", "settings:rbac:manage", BrokenController.prototype.route);

@UseGuards(JwtAuthGuard, PermissionGuard)
class CorrectController {
  @RequirePermission("settings:rbac:manage")
  route(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "/correct", CorrectController.prototype.route);

class NoPermissionKeyController {
  route(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "/no-key", NoPermissionKeyController.prototype.route);

describe("PermissionGuard boot sweep — @RequirePermission without mounted guard", () => {
  it("throws at boot when a route declares @RequirePermission but no PermissionGuard is in its guard chain", () => {
    const guard = makeGuard([new BrokenController()]);
    expect(() => guard.onApplicationBootstrap()).toThrow(/BrokenController#route/);
  });

  it("does not throw at boot when every @RequirePermission route has PermissionGuard in its guard chain", () => {
    const guard = makeGuard([new CorrectController()]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("does not throw when no routes carry @RequirePermission — the sweep is opt-in by decorator", () => {
    const guard = makeGuard([new NoPermissionKeyController()]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("the error message names every route missing the guard, not just the first", () => {
    class SecondBrokenController {
      alpha(): void {}
      beta(): void {}
    }
    Reflect.defineMetadata(PATH_METADATA, "/alpha", SecondBrokenController.prototype.alpha);
    Reflect.defineMetadata("require_permission", "settings:rbac:manage", SecondBrokenController.prototype.alpha);
    Reflect.defineMetadata(PATH_METADATA, "/beta", SecondBrokenController.prototype.beta);
    Reflect.defineMetadata("require_permission", "settings:roles:manage", SecondBrokenController.prototype.beta);

    const guard = makeGuard([new SecondBrokenController()]);
    let thrown: Error | undefined;
    try {
      guard.onApplicationBootstrap();
    } catch (e: unknown) {
      thrown = e instanceof Error ? e : undefined;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toMatch(/SecondBrokenController#alpha/);
    expect(thrown?.message).toMatch(/SecondBrokenController#beta/);
  });

  it("passes when PermissionGuard is mounted at class level and @RequirePermission is at method level", () => {
    @UseGuards(JwtAuthGuard, PermissionGuard)
    class ClassLevelGuardController {
      route(): void {}
    }
    Reflect.defineMetadata(PATH_METADATA, "/cls", ClassLevelGuardController.prototype.route);
    Reflect.defineMetadata(
      "require_permission",
      "settings:rbac:manage",
      ClassLevelGuardController.prototype.route,
    );

    const guard = makeGuard([new ClassLevelGuardController()]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("passes when PermissionGuard is mounted at method level and @RequirePermission is also at method level", () => {
    class MethodLevelGuardController {
      @UseGuards(PermissionGuard)
      @RequirePermission("settings:rbac:manage")
      route(): void {}
    }
    Reflect.defineMetadata(PATH_METADATA, "/mth", MethodLevelGuardController.prototype.route);

    const guard = makeGuard([new MethodLevelGuardController()]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("passes the real application: no controller in the codebase carries @RequirePermission without PermissionGuard", () => {
    const { readdirSync, readFileSync, statSync } = require("node:fs") as typeof import("node:fs");
    const { join, resolve } = require("node:path") as typeof import("node:path");

    const SRC = resolve(__dirname, "..", "..");

    function walk(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries.flatMap((e) => {
        const full = join(dir, e.name);
        if (e.isDirectory()) return walk(full);
        if (e.isFile() && full.endsWith(".controller.ts") && !full.includes(".spec.")) return [full];
        return [];
      });
    }

    const broken: string[] = [];

    for (const file of walk(SRC)) {
      const content = readFileSync(file, "utf8");
      const noComments = content
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      if (!/@RequirePermission\(/.test(noComments)) continue;

      const hasClassGuard = /@UseGuards\([^)]*PermissionGuard/.test(
        noComments.slice(0, noComments.indexOf("class ") + 1000),
      );

      const lines = noComments.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/@RequirePermission\(/.test(lines[i] ?? "")) continue;
        const nearby = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
        const hasMethodGuard = /PermissionGuard/.test(nearby);
        if (!hasClassGuard && !hasMethodGuard) {
          const relative = file.replace(SRC, "").replace(/\\/g, "/");
          broken.push(relative);
        }
      }
    }

    const deduped = [...new Set(broken)];
    expect(deduped).toEqual([]);
  });
});

describe("PermissionGuard boot sweep — guard chain detection completeness", () => {
  it("detects a broken route whose @RequirePermission is at class level", () => {
    class ClassLevelBrokenController {
      route(): void {}
    }
    Reflect.defineMetadata(PATH_METADATA, "/cls-broken", ClassLevelBrokenController.prototype.route);
    Reflect.defineMetadata(
      "require_permission",
      "settings:rbac:manage",
      ClassLevelBrokenController,
    );

    const guard = makeGuard([new ClassLevelBrokenController()]);
    expect(() => guard.onApplicationBootstrap()).toThrow(/ClassLevelBrokenController#route/);
  });

  it("passes when @RequirePermission is at class level and PermissionGuard is also at class level", () => {
    @UseGuards(JwtAuthGuard, PermissionGuard)
    class ClassLevelBothController {
      route(): void {}
    }
    Reflect.defineMetadata(PATH_METADATA, "/cls-both", ClassLevelBothController.prototype.route);
    Reflect.defineMetadata(
      "require_permission",
      "settings:rbac:manage",
      ClassLevelBothController,
    );

    const guard = makeGuard([new ClassLevelBothController()]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });
});
