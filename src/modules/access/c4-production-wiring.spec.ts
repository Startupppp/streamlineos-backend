import { Reflector } from "@nestjs/core";
import { ModuleGuard } from "../../common/rbac/module.guard";
import { REQUIRE_MODULE } from "../../common/rbac/require-module.decorator";
import { PermissionGuard } from "./permission.guard";
import { REQUIRE_PERMISSION } from "./require-permission.decorator";
import { authorize } from "./authorize";
import { AccessSnapshotResolver } from "./access-snapshot.resolver";
import { CATALOG_MODULES } from "./access-policy";
import { moduleAvailability, moduleAvailabilityResolver } from "../../common/rbac/module-availability";
import { resolvePersonalDashboardModules } from "../dashboard/dashboard-scope";
import {
  DASHBOARD_HOME_SECTIONS,
  isModuleSection,
} from "../dashboard/dashboard-section-registry";
import { CalendarSourceRegistry } from "../calendar/calendar-source.registry";
import type { CalendarEventSource } from "../calendar/calendar-event-source";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

/**
 * This harness deliberately has one availability seam.  The test is about
 * production wiring, so the consumers stay real while the database-backed
 * entitlement source is replaced with deterministic facts.
 */
function makeCanonicalWiring() {
  const getModuleMap = jest
    .fn()
    .mockResolvedValue(Object.fromEntries(CATALOG_MODULES.map((key) => [key, true])));
  const getPlanLockedModules = jest.fn().mockResolvedValue([]);
  const getUserDeniedModules = jest.fn().mockResolvedValue(new Set<string>());
  const isCoreModule = jest.fn().mockReturnValue(false);
  const getModuleState = jest.fn().mockResolvedValue(true);
  const buildModuleAvailabilityResolver = jest.fn(
    (
      map: (orgId: string) => Promise<Record<string, boolean>>,
      denies: (orgId: string, userId: string) => Promise<Set<string>> = getUserDeniedModules,
    ) =>
      moduleAvailabilityResolver(
        { isCoreModule, getModuleMap: map, getPlanLockedModules },
        { getUserDeniedModules: denies },
      ),
  );

  const entitlements = {
    isCoreModule,
    getModuleMap,
    getPlanLockedModules,
  };
  const access = {
    buildModuleAvailabilityResolver,
    getModuleState,
    scopeFor: jest.fn().mockResolvedValue("all"),
    moduleAvailability: jest.fn((currentUser: CurrentUserContext, moduleKey: string) =>
      moduleAvailability(
        buildModuleAvailabilityResolver((orgId) => getModuleMap(orgId)),
        currentUser.orgId,
        currentUser.userId,
        moduleKey,
      ),
    ),
    moduleAvailabilityFor: jest.fn((orgId: string, userId: string, moduleKey: string) =>
      moduleAvailability(
        buildModuleAvailabilityResolver((id) => getModuleMap(id)),
        orgId,
        userId,
        moduleKey,
      ),
    ),
  };

  return {
    access,
    entitlements,
    getModuleMap,
    getUserDeniedModules,
    buildModuleAvailabilityResolver,
    getModuleState,
  };
}

function executionContext(metadata: string, userContext = user) {
  const reflector = new Reflector();
  const handler = function handler(): void {};
  Reflect.defineMetadata(REQUIRE_MODULE, metadata, handler);
  Reflect.defineMetadata(REQUIRE_PERMISSION, "settings:rbac:manage", handler);
  const request = { user: userContext };
  return {
    reflector,
    handler,
    context: {
      getHandler: () => handler,
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as never,
  };
}

describe("c4 production access wiring", () => {
  it("keeps guards and calendar sources on the person-aware availability seam", () => {
    const productionCallers = [
      resolve(__dirname, "../../common/rbac/module.guard.ts"),
      resolve(__dirname, "../calendar/calendar-source.registry.ts"),
    ];

    for (const file of productionCallers) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("buildModuleAvailabilityResolver(");
      expect(source).toMatch(/\.moduleAvailability(?:For)?\(/);
    }
  });

  it("routes ModuleGuard and PermissionGuard/authorize through the canonical resolver", async () => {
    const wiring = makeCanonicalWiring();
    const moduleContext = executionContext("build");
    const moduleGuard = new ModuleGuard(
      moduleContext.reflector,
      wiring.access as never,
    );

    await expect(moduleGuard.canActivate(moduleContext.context)).resolves.toBe(true);

    const permissionContext = executionContext("build");
    const permissionGuard = new PermissionGuard(
      permissionContext.reflector,
      wiring.access as never,
    );
    await expect(permissionGuard.canActivate(permissionContext.context)).resolves.toBe(true);

    expect(wiring.buildModuleAvailabilityResolver).toHaveBeenCalledTimes(2);
    expect(wiring.getModuleMap).toHaveBeenCalledWith("org-1");
    expect(wiring.getModuleState).toHaveBeenCalledWith("org-1", "settings");
    expect(wiring.access.scopeFor).toHaveBeenCalledWith(user, "settings:rbac:manage");
  });

  it("keeps authorize on the same AccessService/Entitlements seam", async () => {
    const wiring = makeCanonicalWiring();

    await expect(
      authorize(wiring.access, user, "settings:rbac:manage"),
    ).resolves.toEqual({ allow: true, scope: "all" });

    expect(wiring.getModuleState).toHaveBeenCalledWith("org-1", "settings");
    expect(wiring.buildModuleAvailabilityResolver).toHaveBeenCalledTimes(1);
    expect(wiring.getModuleMap).not.toHaveBeenCalled();
  });

  it("uses the canonical resolver for every access-snapshot module flag", async () => {
    const wiring = makeCanonicalWiring();
    const snapshot = new AccessSnapshotResolver(
      wiring.entitlements as never,
      { resolve: jest.fn().mockResolvedValue({ required: false }) } as never,
      jest.fn().mockResolvedValue(7),
      jest.fn().mockResolvedValue(new Map([["settings:rbac:manage", "all"]])),
      wiring.getUserDeniedModules,
      jest.fn().mockResolvedValue(true),
      wiring.buildModuleAvailabilityResolver,
    );

    const result = await snapshot.computeAccessSnapshot("org-1", "user-1", user);

    expect(result.scopes).toEqual({ "settings:rbac:manage": "all" });
    expect(Object.values(result.modules).every(Boolean)).toBe(true);
    expect(wiring.getModuleMap).toHaveBeenCalledWith("org-1");
    expect(wiring.buildModuleAvailabilityResolver).toHaveBeenCalledTimes(1);
    expect(wiring.getUserDeniedModules).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("keeps dashboard and calendar source availability person-aware", async () => {
    const wiring = makeCanonicalWiring();
    const dashboard = await resolvePersonalDashboardModules(wiring.access as never, user);
    expect(dashboard).toEqual({ build: true, timesheets: true, hr: true });

    const sourceLoad = jest.fn().mockResolvedValue([]);
    const source: CalendarEventSource = {
      key: "build-source",
      label: "Build",
      module: "build",
      load: sourceLoad,
    };
    const registry = new CalendarSourceRegistry(
      wiring.access as never,
      { getDisabledKeys: jest.fn().mockResolvedValue(new Set<string>()) } as never,
    );
    registry.register(source);
    await registry.loadAll({
      orgId: "org-1",
      userId: "user-1",
      start: new Date("2026-08-01"),
      end: new Date("2026-08-31"),
      scope: "all",
    });

    expect(sourceLoad).toHaveBeenCalledTimes(1);
    // Home asks once per distinct module, not once per section, plus the
    // calendar source. Pinning the section count would make deduplicating the
    // lookup read as a regression.
    const distinctHomeModules = new Set(
      DASHBOARD_HOME_SECTIONS.filter(isModuleSection).map((s) => s.module),
    ).size;
    expect(wiring.buildModuleAvailabilityResolver).toHaveBeenCalledTimes(
      distinctHomeModules + 1,
    );
    expect(wiring.getModuleMap).toHaveBeenCalledWith("org-1");
  });
});
