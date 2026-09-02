import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { PermissionGuard } from "../access/permission.guard";
import type { AccessService } from "../access/access.service";
import type { AccessResolver } from "../access/authorize";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { GitConnectionsController } from "../integrations/git/git-connections.controller";
import {
  DEPRECATION_KEY,
  type DeprecationMeta,
} from "../../common/deprecation/deprecated.decorator";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import { AiUsageController } from "../ai/usage/ai-usage.controller";
import { SettingsController } from "./settings.controller";
import { SettingsDeprecatedRoutesController } from "./settings-deprecated-routes.controller";
import { SETTINGS_ALIAS_SUNSET } from "./settings-route-deprecation";

type Handler = (...args: never[]) => unknown;

function gateOf(handler: Handler): string | undefined {
  return Reflect.getMetadata(REQUIRE_PERMISSION, handler) as string | undefined;
}

function deprecationOf(handler: Handler): DeprecationMeta | undefined {
  return Reflect.getMetadata(DEPRECATION_KEY, handler) as
    | DeprecationMeta
    | undefined;
}

const catalog = new Set(ALL_PERMISSION_NAMES);
const settings = SettingsController.prototype;
const aliases = SettingsDeprecatedRoutesController.prototype;

describe("custom fields have a read rung, not only a manage rung", () => {
  it("carries both keys in the catalogue, so the read rung is grantable", () => {
    expect(catalog.has("settings:custom-fields:view")).toBe(true);
    expect(catalog.has("settings:custom-fields:manage")).toBe(true);
  });

  it("gates the list on the view key — a reader needs no authority to change definitions", () => {
    expect(gateOf(settings.listCustomFields)).toBe("settings:custom-fields:view");
  });

  it("still gates every write on manage, so the rung is a read rung and not a hole", () => {
    expect(gateOf(settings.createCustomField)).toBe("settings:custom-fields:manage");
    expect(gateOf(settings.updateCustomField)).toBe("settings:custom-fields:manage");
    expect(gateOf(settings.deleteCustomField)).toBe("settings:custom-fields:manage");
  });
});

describe("AI usage is served by the module that owns it", () => {
  it("mounts the canonical route under its own module namespace and key", () => {
    expect(gateOf(AiUsageController.prototype.getUsage)).toBe("ai:usage:view");
    expect(catalog.has("ai:usage:view")).toBe(true);
  });

  it("keeps the global path only as a dated alias on the same key", () => {
    expect(gateOf(aliases.getAiUsage)).toBe("ai:usage:view");
    expect(deprecationOf(aliases.getAiUsage)).toEqual({
      sunset: SETTINGS_ALIAS_SUNSET,
      link: "/ai/usage",
    });
  });
});

describe("the role-change alias points at the route that absorbed it", () => {
  it("declares a sunset and names the surviving path", () => {
    expect(deprecationOf(aliases.updateUserRole)).toEqual({
      sunset: SETTINGS_ALIAS_SUNSET,
      link: "/organization/members/:memberId",
    });
  });
});

describe("a deprecation is a dated promise, not a label", () => {
  it("every handler on the alias controller is deprecated, dated and points somewhere", () => {
    const handlers = Object.getOwnPropertyNames(aliases).filter(
      (name) => name !== "constructor",
    );

    expect(handlers.length).toBeGreaterThan(0);
    for (const name of handlers) {
      const meta = deprecationOf(
        (aliases as unknown as Record<string, Handler>)[name] as Handler,
      );
      expect({ name, sunset: meta?.sunset }).toEqual({
        name,
        sunset: SETTINGS_ALIAS_SUNSET,
      });
      expect(meta?.link ?? "").toMatch(/^\//);
    }
  });

  it("nothing on the primary settings controller is deprecated — the debt lives in one file", () => {
    const stragglers = Object.getOwnPropertyNames(settings)
      .filter((name) => name !== "constructor")
      .filter(
        (name) =>
          deprecationOf(
            (settings as unknown as Record<string, Handler>)[name] as Handler,
          ) !== undefined,
      );
    expect(stragglers).toEqual([]);
  });

  it("the sunset is a real future date, not a placeholder", () => {
    expect(SETTINGS_ALIAS_SUNSET).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(SETTINGS_ALIAS_SUNSET))).toBe(false);
  });
});

/**
 * The deny branch, executed rather than declared.
 *
 * Every assertion above reads a decorator. A decorator can name a key nobody
 * holds, sit under a class the guard never runs, or be typed against a route
 * that moved — and all three ship green against metadata. These run the real
 * `PermissionGuard` over the real handler metadata with an access resolver that
 * holds nothing, so the 403 is the guard's, and then run it again holding the
 * one key to prove the gate is a gate and not a wall.
 */
const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function accessHolding(keys: readonly string[]): AccessService {
  const held = new Set(keys);
  const resolver: AccessResolver = {
    scopeFor: async (_user, key) => (held.has(key) ? "all" : "none"),
    getModuleState: async () => true,
    buildModuleAvailabilityResolver: (getModuleMap) => ({
      isCoreModule: () => true,
      getModuleMap,
      getUserDeniedModules: async () => new Set<string>(),
      getPlanLockedModules: async () => [],
    }),
  };
  return resolver as unknown as AccessService;
}

function canActivate(
  controller: NewableFunction,
  handler: Handler,
  keys: readonly string[],
): Promise<boolean> {
  const context = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: actor }) }),
  } as unknown as ExecutionContext;
  return new PermissionGuard(new Reflector(), accessHolding(keys)).canActivate(context);
}

const gitConnections = GitConnectionsController.prototype;
const GATED_ROUTES = [
  {
    route: "GET /ai/usage",
    controller: AiUsageController,
    handler: AiUsageController.prototype.getUsage,
    key: "ai:usage:view",
  },
  {
    route: "GET /integrations/git/connections",
    controller: GitConnectionsController,
    handler: gitConnections.listConnections,
    key: "integrations:git:view",
  },
  {
    route: "POST /integrations/git/connections",
    controller: GitConnectionsController,
    handler: gitConnections.createConnection,
    key: "integrations:git:manage",
  },
  {
    route: "PATCH /integrations/git/connections/*",
    controller: GitConnectionsController,
    handler: gitConnections.updateConnection,
    key: "integrations:git:manage",
  },
  {
    route: "DELETE /integrations/git/connections/*",
    controller: GitConnectionsController,
    handler: gitConnections.deleteConnection,
    key: "integrations:git:manage",
  },
  {
    route: "GET /settings/ai-usage",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.getAiUsage,
    key: "ai:usage:view",
  },
  {
    route: "GET /settings/integrations/git",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.listGitConnections,
    key: "integrations:git:view",
  },
  {
    route: "POST /settings/integrations/git",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.createGitConnection,
    key: "integrations:git:manage",
  },
  {
    route: "PATCH /settings/integrations/git/*",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.updateGitConnection,
    key: "integrations:git:manage",
  },
  {
    route: "DELETE /settings/integrations/git/*",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.deleteGitConnection,
    key: "integrations:git:manage",
  },
  {
    route: "GET /settings/custom-fields",
    controller: SettingsController,
    handler: settings.listCustomFields,
    key: "settings:custom-fields:view",
  },
  {
    route: "POST /settings/custom-fields",
    controller: SettingsController,
    handler: settings.createCustomField,
    key: "settings:custom-fields:manage",
  },
  {
    route: "PATCH /settings/custom-fields/*",
    controller: SettingsController,
    handler: settings.updateCustomField,
    key: "settings:custom-fields:manage",
  },
  {
    route: "DELETE /settings/custom-fields/*",
    controller: SettingsController,
    handler: settings.deleteCustomField,
    key: "settings:custom-fields:manage",
  },
] as const;

describe("every route that moved denies a caller who holds no key", () => {
  it.each(GATED_ROUTES)(
    "$route is refused by PermissionGuard",
    async ({ controller, handler }) => {
      await expect(canActivate(controller, handler, [])).rejects.toThrow(
        ForbiddenException,
      );
    },
  );

  it.each(GATED_ROUTES)(
    "$route opens for the one key it names",
    async ({ controller, handler, key }) => {
      await expect(canActivate(controller, handler, [key])).resolves.toBe(true);
    },
  );
});

describe("the custom-fields read rung is a rung, not a hole", () => {
  const readOnly = ["settings:custom-fields:view"];

  it("lets the reader list definitions", async () => {
    await expect(
      canActivate(SettingsController, settings.listCustomFields, readOnly),
    ).resolves.toBe(true);
  });

  it.each([
    ["createCustomField", settings.createCustomField],
    ["updateCustomField", settings.updateCustomField],
    ["deleteCustomField", settings.deleteCustomField],
  ])("refuses the reader %s", async (_name, handler) => {
    await expect(
      canActivate(SettingsController, handler as Handler, readOnly),
    ).rejects.toThrow(ForbiddenException);
  });
});
