import "reflect-metadata";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { DashboardController } from "./dashboard.controller";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { REQUIRE_MODULE } from "../../common/rbac/require-module.decorator";
import { IS_UNIVERSAL } from "../../common/auth/universal.decorator";
import {
  DASHBOARD_HOME_SECTIONS,
  isModuleSection,
  isPermissionSection,
  permissionOf,
  type DashboardSection,
  type ModuleSection,
  type PermissionSection,
} from "./dashboard-section-registry";

describe("DASHBOARD_HOME_SECTIONS — authoritative section registry (ITEMS A+B)", () => {
  it("registry is non-empty", () => {
    expect(DASHBOARD_HOME_SECTIONS.length).toBeGreaterThan(0);
  });

  it("FAIL-CLOSED: every section has a recognised kind — adding a section without a valid kind makes this test red", () => {
    const VALID = new Set(["universal", "module", "permission"]);
    for (const section of DASHBOARD_HOME_SECTIONS) {
      if (!VALID.has(section.kind)) {
        throw new Error(
          `Section '${section.key}' is unclassified (kind='${section.kind}'). ` +
            `Classify it as universal, module, or permission in dashboard-section-registry.ts.`,
        );
      }
    }
  });

  it("every section has a non-empty key and cacheNs", () => {
    for (const section of DASHBOARD_HOME_SECTIONS) {
      expect(section.key.length).toBeGreaterThan(0);
      expect(section.cacheNs.length).toBeGreaterThan(0);
    }
  });

  it("section keys are unique", () => {
    const keys = DASHBOARD_HOME_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every module section declares a non-empty module string", () => {
    const modules = DASHBOARD_HOME_SECTIONS.filter(isModuleSection) as ModuleSection[];
    expect(modules.length).toBeGreaterThan(0);
    for (const s of modules) {
      expect(typeof s.module).toBe("string");
      expect(s.module.length).toBeGreaterThan(0);
    }
  });

  it("every permission section declares a permission string and cacheScope", () => {
    const perms = DASHBOARD_HOME_SECTIONS.filter(isPermissionSection) as PermissionSection[];
    expect(perms.length).toBeGreaterThan(0);
    for (const s of perms) {
      expect(typeof s.permission).toBe("string");
      expect(s.permission.length).toBeGreaterThan(0);
      expect(["org", "scoped"]).toContain(s.cacheScope);
    }
  });

  it("permission keys follow the module:resource:action naming convention", () => {
    const perms = DASHBOARD_HOME_SECTIONS.filter(isPermissionSection) as PermissionSection[];
    for (const s of perms) {
      expect(s.permission).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]+/);
    }
  });

  it("universal sections carry no module or permission field", () => {
    const universals = DASHBOARD_HOME_SECTIONS.filter((s) => s.kind === "universal");
    for (const s of universals) {
      expect(Object.prototype.hasOwnProperty.call(s, "permission")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(s, "module")).toBe(false);
    }
  });

  it("ITEM B — known universal sections (per §8 CLAUDE.md) are classified as universal", () => {
    const universalKeys = new Set(
      DASHBOARD_HOME_SECTIONS.filter((s) => s.kind === "universal").map((s) => s.key),
    );
    expect(universalKeys.has("announcements")).toBe(true);
    expect(universalKeys.has("upcoming-events")).toBe(true);
    expect(universalKeys.has("unread-notifications")).toBe(true);
  });

  it("ITEM B — HR admin sections are NOT classified as universal", () => {
    const nonUniversalKeys = new Set(
      DASHBOARD_HOME_SECTIONS.filter((s) => s.kind !== "universal").map((s) => s.key),
    );
    expect(nonUniversalKeys.has("stats-employees")).toBe(true);
    expect(nonUniversalKeys.has("pending-approvals")).toBe(true);
    expect(nonUniversalKeys.has("crm-executive")).toBe(true);
  });

  it("module-gated sections that require a specific module are not classified as universal", () => {
    const universalKeys = new Set(
      DASHBOARD_HOME_SECTIONS.filter((s) => s.kind === "universal").map((s) => s.key),
    );
    expect(universalKeys.has("birthdays")).toBe(false);
    expect(universalKeys.has("my-issues")).toBe(false);
    expect(universalKeys.has("upcoming-holidays")).toBe(false);
    expect(universalKeys.has("active-sprint")).toBe(false);
  });
});

describe("permissionOf helper", () => {
  it("returns the permission key for a permission section", () => {
    expect(permissionOf("stats-employees")).toBe("hr:employees:view");
    expect(permissionOf("stats-projects")).toBe("build:tickets:view");
    expect(permissionOf("recent-projects")).toBe("build:tickets:view");
    expect(permissionOf("leaves-today")).toBe("hr:leaves:view");
  });

  it("throws for an unknown section key", () => {
    expect(() => permissionOf("nonexistent-section")).toThrow();
  });

  it("throws for a universal section key (not a permission section)", () => {
    expect(() => permissionOf("announcements")).toThrow();
  });

  it("throws for a module section key (not a permission section)", () => {
    expect(() => permissionOf("my-tasks")).toThrow();
  });
});

describe("registry ↔ controller cross-check", () => {
  const GET = 0;

  interface HandlerMeta {
    permission: string | undefined;
    module: string | undefined;
    isUniversal: boolean;
  }

  function buildRouteMap(): Map<string, HandlerMeta> {
    const proto = DashboardController.prototype as unknown as Record<string, unknown>;
    const map = new Map<string, HandlerMeta>();
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const handler = proto[name];
      if (typeof handler !== "function") continue;
      if (Reflect.getMetadata(METHOD_METADATA, handler) !== GET) continue;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (!path) continue;
      map.set(path, {
        permission: Reflect.getMetadata(REQUIRE_PERMISSION, handler) as string | undefined,
        module: Reflect.getMetadata(REQUIRE_MODULE, handler) as string | undefined,
        isUniversal: Reflect.getMetadata(IS_UNIVERSAL, handler) === true,
      });
    }
    return map;
  }

  it("every registry entry with a routePath matches its controller handler on permission key, module key and universality", () => {
    const routeMap = buildRouteMap();
    for (const section of DASHBOARD_HOME_SECTIONS as DashboardSection[]) {
      if (!("routePath" in section) || section.routePath === undefined) continue;
      const meta = routeMap.get(section.routePath);
      if (!meta) {
        throw new Error(
          `Registry key '${section.key}' declares routePath='${section.routePath}' ` +
            `but DashboardController has no GET handler at that path`,
        );
      }
      if (section.kind === "universal") {
        if (meta.permission !== undefined) {
          throw new Error(
            `Registry key '${section.key}' is kind='universal' but controller route ` +
              `'${section.routePath}' carries @RequirePermission('${meta.permission}')`,
          );
        }
        if (meta.module !== undefined) {
          throw new Error(
            `Registry key '${section.key}' is kind='universal' but controller route ` +
              `'${section.routePath}' carries @RequireModule('${meta.module}')`,
          );
        }
      } else if (section.kind === "module") {
        const moduleSection = section as ModuleSection;
        if (meta.module !== moduleSection.module) {
          throw new Error(
            `Registry key '${section.key}' declares module='${moduleSection.module}' but ` +
              `controller route '${section.routePath}' has @RequireModule('${meta.module ?? "none"}')`,
          );
        }
        if (!meta.isUniversal) {
          throw new Error(
            `Registry key '${section.key}' is kind='module' but controller route ` +
              `'${section.routePath}' is not decorated with @Universal()`,
          );
        }
      } else if (section.kind === "permission") {
        const permSection = section as PermissionSection;
        if (meta.permission !== permSection.permission) {
          throw new Error(
            `Registry key '${section.key}' declares permission='${permSection.permission}' but ` +
              `controller route '${section.routePath}' has @RequirePermission('${meta.permission ?? "none"}')`,
          );
        }
      }
    }
  });

  it("the route map covers every GET handler registered in DashboardController", () => {
    const routeMap = buildRouteMap();
    expect(routeMap.size).toBeGreaterThan(0);
  });
});
