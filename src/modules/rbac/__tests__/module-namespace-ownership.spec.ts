import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("the Home backfill matches what the corrected templates grant", () => {
  const catalog = new Set(PERMISSIONS.map((p) => p.name));
  const migration = readFileSync(
    join(process.cwd(), "migrations", "0450_home_module_access_keys.sql"),
    "utf8",
  );

  it("grants owner and admin exactly the access keys their template now produces", () => {
    const templateKeys = buildModuleAdminPermissionKeys("home", catalog).filter(
      (key) => key.startsWith("home:access:"),
    );
    expect(templateKeys.sort()).toEqual([
      "home:access:manage",
      "home:access:view",
    ]);
    for (const key of templateKeys) expect(migration).toContain(key);
    expect(migration).toContain("'HOME_MODULE_OWNER', 'HOME_MODULE_ADMIN'");
  });

  it("grants the member role only the read key, as every other module's member role holds", () => {
    expect(
      buildModuleMemberPermissionKeys("home", catalog).filter((key) =>
        key.startsWith("home:access:"),
      ),
    ).toEqual(["home:access:view"]);
    expect(buildModuleMemberPermissionKeys("hr", catalog)).toContain(
      "hr:access:view",
    );
    expect(migration).toContain("'HOME_MODULE_MEMBER'");
  });

  it("bumps the permission version, so a cached resolution cannot hide the new keys", () => {
    expect(migration).toContain("access_versions");
    expect(migration).toContain('"permissions_version" + 1');
  });
});
