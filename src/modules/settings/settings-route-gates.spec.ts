import { testAuthContext } from "../../../test/helpers/module-guard-context";
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
import { CrmCustomFieldsController } from "../crm/custom-fields/crm-custom-fields.controller";
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

const customFields = CrmCustomFieldsController.prototype;

describe("custom fields are served by the module that owns them", () => {
  it("carries both CRM keys in the catalogue, so a module rung can hold them", () => {
    expect(catalog.has("crm:custom-fields:view")).toBe(true);
    expect(catalog.has("crm:custom-fields:manage")).toBe(true);
  });

  it("gates the canonical list on the CRM view key, not on organisation administration", () => {
    expect(gateOf(customFields.listCustomFields)).toBe("crm:custom-fields:view");
  });

  it("still gates every canonical write on manage, so the rung is a read rung and not a hole", () => {
    expect(gateOf(customFields.createCustomField)).toBe("crm:custom-fields:manage");
    expect(gateOf(customFields.updateCustomField)).toBe("crm:custom-fields:manage");
    expect(gateOf(customFields.deleteCustomField)).toBe("crm:custom-fields:manage");
  });

  /*
   * The alias deliberately keeps the OLD keys. ORG_ADMIN and OWNER are the only
   * standings that hold `settings:custom-fields:*` today; re-gating the alias on
   * the CRM pair would take the screen away from the roles that can reach it now.
   */
  it("keeps the global path on the old keys so no standing loses the screen mid-release", () => {
    expect(catalog.has("settings:custom-fields:view")).toBe(true);
    expect(catalog.has("settings:custom-fields:manage")).toBe(true);
    expect(gateOf(aliases.listCustomFields)).toBe("settings:custom-fields:view");
    expect(gateOf(aliases.createCustomField)).toBe("settings:custom-fields:manage");
    expect(gateOf(aliases.updateCustomField)).toBe("settings:custom-fields:manage");
    expect(gateOf(aliases.deleteCustomField)).toBe("settings:custom-fields:manage");
  });

  it("leaves nothing custom-field shaped on the primary settings controller", () => {
    const left = Object.getOwnPropertyNames(settings).filter((name) =>
      name.toLowerCase().includes("customfield"),
    );
    expect(left).toEqual([]);
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
  const authContext = testAuthContext(actor, {
    moduleAvailability: async () => ({ available: true }),
  });
  const context = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: actor, authContext }) }),
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
    route: "GET /crm/settings/custom-fields",
    controller: CrmCustomFieldsController,
    handler: customFields.listCustomFields,
    key: "crm:custom-fields:view",
  },
  {
    route: "POST /crm/settings/custom-fields",
    controller: CrmCustomFieldsController,
    handler: customFields.createCustomField,
    key: "crm:custom-fields:manage",
  },
  {
    route: "PATCH /crm/settings/custom-fields/*",
    controller: CrmCustomFieldsController,
    handler: customFields.updateCustomField,
    key: "crm:custom-fields:manage",
  },
  {
    route: "DELETE /crm/settings/custom-fields/*",
    controller: CrmCustomFieldsController,
    handler: customFields.deleteCustomField,
    key: "crm:custom-fields:manage",
  },
  {
    route: "GET /settings/custom-fields",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.listCustomFields,
    key: "settings:custom-fields:view",
  },
  {
    route: "POST /settings/custom-fields",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.createCustomField,
    key: "settings:custom-fields:manage",
  },
  {
    route: "PATCH /settings/custom-fields/*",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.updateCustomField,
    key: "settings:custom-fields:manage",
  },
  {
    route: "DELETE /settings/custom-fields/*",
    controller: SettingsDeprecatedRoutesController,
    handler: aliases.deleteCustomField,
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
  const readOnly = ["crm:custom-fields:view"];

  it("lets the reader list definitions", async () => {
    await expect(
      canActivate(CrmCustomFieldsController, customFields.listCustomFields, readOnly),
    ).resolves.toBe(true);
  });

  it.each([
    ["createCustomField", customFields.createCustomField],
    ["updateCustomField", customFields.updateCustomField],
    ["deleteCustomField", customFields.deleteCustomField],
  ])("refuses the reader %s", async (_name, handler) => {
    await expect(
      canActivate(CrmCustomFieldsController, handler as Handler, readOnly),
    ).rejects.toThrow(ForbiddenException);
  });

  /*
   * The move must not become a lateral hole: the organisation-administration key
   * has no authority on the module's own path, and the module key has none on
   * the alias. Either direction would make the two surfaces one surface again.
   */
  it("refuses the canonical route to a holder of the old global key alone", async () => {
    await expect(
      canActivate(CrmCustomFieldsController, customFields.listCustomFields, [
        "settings:custom-fields:manage",
      ]),
    ).rejects.toThrow(ForbiddenException);
  });

  it("refuses the alias to a holder of the CRM key alone", async () => {
    await expect(
      canActivate(SettingsDeprecatedRoutesController, aliases.listCustomFields, [
        "crm:custom-fields:manage",
      ]),
    ).rejects.toThrow(ForbiddenException);
  });
});
