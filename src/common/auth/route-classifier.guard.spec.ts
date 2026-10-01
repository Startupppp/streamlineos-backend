import { ForbiddenException } from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { RouteClassifierGuard } from "./route-classifier.guard";
import { Public } from "./public.decorator";
import { Universal } from "./universal.decorator";
import { AuthorizedInService } from "./authorized-in-service.decorator";
import { RequirePermission } from "../../modules/access/require-permission.decorator";
import { validateEnv, type AppConfig } from "../../config/env.validation";

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

class MultiKeyPermissionedController {
  @RequirePermission("timesheets:entries:view", "timesheets:team:view")
  route(): void {}
}
Reflect.defineMetadata(
  PATH_METADATA,
  "multi-key-permissioned",
  MultiKeyPermissionedController.prototype.route,
);

@AuthorizedInService("assertModuleAccessPolicy")
class InServiceController {
  route(): void {}
}
Reflect.defineMetadata(PATH_METADATA, "in-service", InServiceController.prototype.route);

/** An empty name is not a declaration — the point of the decorator is the name. */
@AuthorizedInService("")
class UnnamedInServiceController {
  route(): void {}
}
Reflect.defineMetadata(
  PATH_METADATA,
  "unnamed-in-service",
  UnnamedInServiceController.prototype.route,
);

/**
 * The enforcement switch is a constructor argument now, not an ambient
 * variable, so each test states the deployment it is describing. Default is
 * unset, which is the production default: enforce.
 */
type EnforcementConfig = Pick<AppConfig, "REQUIRE_ROUTE_CLASSIFICATION">;

const ENFORCING: EnforcementConfig = {};
const NOT_ENFORCING: EnforcementConfig = { REQUIRE_ROUTE_CLASSIFICATION: "false" };
const ENFORCING_EXPLICITLY: EnforcementConfig = { REQUIRE_ROUTE_CLASSIFICATION: "true" };

/** The minimum `validateEnv` accepts, so the typo test below varies one key. */
const VALID_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BACKEND_JWT_SECRET: "x".repeat(44),
  PORTAL_JWT_SECRET: "y".repeat(44),
  CORS_ORIGINS: "https://app.example.com",
  APP_URL: "https://app.example.com",
  ENCRYPTION_KEY: "e".repeat(64),
};

function makeGuard(
  instances: object[],
  config: EnforcementConfig = ENFORCING,
): RouteClassifierGuard {
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
  return new RouteClassifierGuard(reflector, discovery, scanner, config);
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

describe("RouteClassifierGuard enforcement default", () => {
  it("denies an undeclared route when the variable is unset", () => {
    expect(() =>
      makeGuard([], ENFORCING).canActivate(
        executionContext(UnclassifiedController, UnclassifiedController.prototype.route),
      ),
    ).toThrow(ForbiddenException);
  });

  it("refuses to boot with an undeclared route when the variable is unset", () => {
    expect(() =>
      makeGuard([new UnclassifiedController()], ENFORCING).onApplicationBootstrap(),
    ).toThrow(
      /UnclassifiedController#route/,
    );
  });

  /*
   * This used to set the variable to "no" and assert the guard still enforced,
   * because `!== "false"` was the only thing standing between a typo and an
   * unguarded platform. Enforcement no longer reads the environment, so the
   * property is pinned one level up, where it is now stronger: a misspelled
   * value does not reach the guard at all, it refuses the boot.
   */
  it("a typo in the switch fails validation rather than reaching the guard", () => {
    expect(() =>
      validateEnv({ ...VALID_ENV, REQUIRE_ROUTE_CLASSIFICATION: "no" }),
    ).toThrow(/REQUIRE_ROUTE_CLASSIFICATION/);
    expect(
      validateEnv({ ...VALID_ENV, REQUIRE_ROUTE_CLASSIFICATION: "false" })
        .REQUIRE_ROUTE_CLASSIFICATION,
    ).toBe("false");
  });
});

describe("RouteClassifierGuard.onApplicationBootstrap", () => {
  it("throws when enforcement is on and an undeclared route is present", () => {
    const guard = makeGuard([new UnclassifiedController()], ENFORCING_EXPLICITLY);
    expect(() => guard.onApplicationBootstrap()).toThrow(
      /UnclassifiedController#route/,
    );
  });

  it("does not throw when enforcement is explicitly disabled", () => {
    const guard = makeGuard([new UnclassifiedController()], NOT_ENFORCING);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("does not throw when all routes are declared", () => {
    const guard = makeGuard([
      new PublicController(),
      new UniversalController(),
      new PermissionedController(),
    ], ENFORCING_EXPLICITLY);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
  });

  it("counts a route naming SEVERAL permission keys as declared, so BE-30 cannot miss it", () => {
    const guard = makeGuard([new MultiKeyPermissionedController()], ENFORCING_EXPLICITLY);
    expect(() => guard.onApplicationBootstrap()).not.toThrow();
    const undeclared = (guard as unknown as { undeclared: Set<string> }).undeclared;
    expect(undeclared.size).toBe(0);
  });

  it("populates the undeclared set with the controller#method label", () => {
    const guard = makeGuard([new UnclassifiedController()], NOT_ENFORCING);
    guard.onApplicationBootstrap();
    const undeclared = (guard as unknown as { undeclared: Set<string> }).undeclared;
    expect(undeclared.has("UnclassifiedController#route")).toBe(true);
  });
});

describe("RouteClassifierGuard.canActivate", () => {
  it("allows a @Public route regardless of enforcement", () => {
    const guard = makeGuard([], ENFORCING_EXPLICITLY);
    const result = guard.canActivate(
      executionContext(PublicController, PublicController.prototype.route),
    );
    expect(result).toBe(true);
  });

  it("allows a @Universal route regardless of enforcement", () => {
    const guard = makeGuard([], ENFORCING_EXPLICITLY);
    const result = guard.canActivate(
      executionContext(UniversalController, UniversalController.prototype.route),
    );
    expect(result).toBe(true);
  });

  it("allows a @RequirePermission route regardless of enforcement", () => {
    const guard = makeGuard([], ENFORCING_EXPLICITLY);
    const result = guard.canActivate(
      executionContext(PermissionedController, PermissionedController.prototype.route),
    );
    expect(result).toBe(true);
  });

  it("allows an @AuthorizedInService route regardless of enforcement", () => {
    const guard = makeGuard([], ENFORCING_EXPLICITLY);
    const result = guard.canActivate(
      executionContext(InServiceController, InServiceController.prototype.route),
    );
    expect(result).toBe(true);
  });

  it("denies @AuthorizedInService with an empty name — naming the check is the point", () => {
    const guard = makeGuard([], ENFORCING_EXPLICITLY);
    expect(() =>
      guard.canActivate(
        executionContext(
          UnnamedInServiceController,
          UnnamedInServiceController.prototype.route,
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it("denies an undeclared route with ForbiddenException when enforcement is on", () => {
    const guard = makeGuard([], ENFORCING_EXPLICITLY);
    expect(() =>
      guard.canActivate(
        executionContext(UnclassifiedController, UnclassifiedController.prototype.route),
      ),
    ).toThrow(ForbiddenException);
  });

  it("allows an undeclared route only when enforcement is explicitly disabled", () => {
    const guard = makeGuard([], NOT_ENFORCING);
    const result = guard.canActivate(
      executionContext(UnclassifiedController, UnclassifiedController.prototype.route),
    );
    expect(result).toBe(true);
  });
});
