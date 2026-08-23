import {
  ACCESS_MANAGED_MODULES,
  PERMISSIONS,
  moduleScopedPermissions,
} from "../permissions";
import {
  buildModuleAdminPermissionKeys,
  buildModuleMemberPermissionKeys,
} from "../seed-system-roles";

describe("which permission keys a module owns", () => {
  it.each(ACCESS_MANAGED_MODULES)(
    "gives %s its own access keys, so its owner can open its access screen",
    (moduleKey) => {
      const owned = moduleScopedPermissions(moduleKey);
      expect(owned).toContain(`${moduleKey}:access:view`);
      expect(owned).toContain(`${moduleKey}:access:manage`);
    },
  );

  it("gives Home the communication namespaces it administers", () => {
    const owned = moduleScopedPermissions("home");
    expect(owned).toContain("chat:channels:read");
    expect(owned).toContain("mail:inbox:view");
    expect(owned).toContain("calendar:read");
    expect(owned).toContain("notifications:policy:view");
  });

  it("does not give a module a namespace it does not administer", () => {
    const home = moduleScopedPermissions("home");
    expect(home).not.toContain("hr:employees:view");

    const hr = moduleScopedPermissions("hr");
    expect(hr).not.toContain("chat:channels:read");
    expect(hr).not.toContain("home:access:view");
  });
});

/**
 * Home is universal to every active member, so there is nothing to grant per
 * role and no access screen to open. It still ADMINISTERS the communication
 * namespaces above — that mapping lives in `ADDITIONAL_MODULE_NAMESPACES` and is
 * deliberately independent of whether a module is access-managed.
 */
describe("Home is administered without an access ladder of its own", () => {
  const catalog = new Set(PERMISSIONS.map((p) => p.name));

  it("is not an access-managed module", () => {
    expect(ACCESS_MANAGED_MODULES).not.toContain("home");
  });

  it("keeps no home:access key in the catalog", () => {
    expect(catalog.has("home:access:view")).toBe(false);
    expect(catalog.has("home:access:manage")).toBe(false);
  });

  it("seeds no home:access key onto any role template", () => {
    for (const build of [
      buildModuleAdminPermissionKeys,
      buildModuleMemberPermissionKeys,
    ])
      expect(
        build("home", catalog).filter((key) => key.startsWith("home:access:")),
      ).toEqual([]);

    expect(buildModuleMemberPermissionKeys("hr", catalog)).toContain(
      "hr:access:view",
    );
  });
});
