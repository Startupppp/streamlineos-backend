import { ForbiddenException } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { RouteClassifierGuard } from "./route-classifier.guard";
import { Public } from "./public.decorator";
import { Universal } from "./universal.decorator";
import { RequirePermission } from "../../modules/access/require-permission.decorator";

class UnclassifiedController {
  route(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "unclassified", UnclassifiedController.prototype.route);

@Public()
class PublicController {
  route(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "public", PublicController.prototype.route);

@Universal()
class UniversalController {
  route(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "universal", UniversalController.prototype.route);

class PermissionedController {
  @RequirePermission("settings:rbac:manage")
  route(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "permissioned", PermissionedController.prototype.route);

function makeGuard(instances: object[]): RouteClassifierGuard {
  const reflector = new Reflector();
  const discovery = {
    getControllers: () => instances.map((instance) => ({ instance })),
  } as never;
  const scanner = {
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
  } as never;
  return new RouteClassifierGuard(reflector, discovery, scanner);
}

function executionContext(
  controllerClass: new () => object,
  handlerFn: (...args: unknown[]) => unknown,
) {
  return {
    getHandler: () => handlerFn,
    getClass: () => controllerClass,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as never;
}

const originalEnv = process.env["REQUIRE_ROUTE_CLASSIFICATION"];

afterEach(() => {
  if (originalEnv === undefined) delete process.env["REQUIRE_ROUTE_CLASSIFICATION"];
  else process.env["REQUIRE_ROUTE_CLASSIFICATION"] = originalEnv;
});

describe("RouteClassifierGuard.onApplicationBootstrap", () => {
  it("throws when enforcement is on and an undeclared route is present", () => {
    process.env["REQUIRE_ROUTE_CLASSIFICATION"] = "true";
    const guard = makeGuard([new UnclassifiedController()]);
    expect(() => guard.onApplicationBootstrap()).toThrow(
      /UnclassifiedController#route/,
    );
  });

  it("does not throw when enforcement is off, even with undeclared routes", () => {
    delete process.env["REQUIRE_ROUTE_CLASSIFICATION"];
    const guard = makeGuard([new UnclassifiedController()]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("does not throw when all routes are declared", () => {
    process.env["REQUIRE_ROUTE_CLASSIFICATION"] = "true";
    const guard = makeGuard([
      new PublicController(),
      new UniversalController(),
      new PermissionedController(),
    ]);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("populates the undeclared set with the controller#method label", () => {
    delete process.env["REQUIRE_ROUTE_CLASSIFICATION"];
    const guard = makeGuard([new UnclassifiedController()]);
    guard.onApplicationBootstrap();
    const undeclared = (guard as unknown as { undeclared: Set<string> }).undeclared;
    expect(undeclared.has("UnclassifiedController#route")).toBe(true);
  });
});

describe("RouteClassifierGuard.canActivate", () => {
  it("allows a @Public route regardless of enforcement", () => {
    process.env["REQUIRE_ROUTE_CLASSIFICATION"] = "true";
    const guard = makeGuard([]);
    const result = guard.canActivate(
      executionContext(PublicController, PublicController.prototype.route),
    );
    expect(result).toBe(true);
  });

  it("allows a @Universal route regardless of enforcement", () => {
    process.env["REQUIRE_ROUTE_CLASSIFICATION"] = "true";
    const guard = makeGuard([]);
    const result = guard.canActivate(
      executionContext(UniversalController, UniversalController.prototype.route),
    );
    expect(result).toBe(true);
  });

  it("allows a @RequirePermission route regardless of enforcement", () => {
    process.env["REQUIRE_ROUTE_CLASSIFICATION"] = "true";
    const guard = makeGuard([]);
    const result = guard.canActivate(
      executionContext(PermissionedController, PermissionedController.prototype.route),
    );
    expect(result).toBe(true);
  });

  it("denies an undeclared route with ForbiddenException when enforcement is on", () => {
    process.env["REQUIRE_ROUTE_CLASSIFICATION"] = "true";
    const guard = makeGuard([]);
    expect(() =>
      guard.canActivate(
        executionContext(UnclassifiedController, UnclassifiedController.prototype.route),
      ),
    ).toThrow(ForbiddenException);
  });

  it("allows an undeclared route when enforcement is off", () => {
    delete process.env["REQUIRE_ROUTE_CLASSIFICATION"];
    const guard = makeGuard([]);
    const result = guard.canActivate(
      executionContext(UnclassifiedController, UnclassifiedController.prototype.route),
    );
    expect(result).toBe(true);
  });
});
