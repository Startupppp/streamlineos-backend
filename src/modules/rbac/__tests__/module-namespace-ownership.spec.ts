import { ACCESS_MANAGED_MODULES, moduleScopedPermissions } from "../permissions";

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
