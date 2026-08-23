import { ACCESS_MANAGED_MODULES } from "../permissions";
import { MODULE_CATALOG } from "../../../common/rbac/module-vocabulary";

const CORE_MODULES = new Set<string>([
  "kb",
  "home",
  "chat",
  "mail",
  "calendar",
  "notifications",
  "workflows",
  "blog",
  "directory",
]);

const seedsOwnerRole = new Set<string>(ACCESS_MANAGED_MODULES);

describe("every module that can take an ownership row has an owner role to assign", () => {
  it.each(MODULE_CATALOG.filter((moduleKey) => !CORE_MODULES.has(moduleKey)))(
    "%s is toggleable, so enabling it must find its *_MODULE_OWNER role",
    (moduleKey) => {
      expect(seedsOwnerRole.has(moduleKey)).toBe(true);
    },
  );

  it("leaves no toggleable module without an owner role, which would fail the enable", () => {
    const toggleable = MODULE_CATALOG.filter((m) => !CORE_MODULES.has(m));
    expect(toggleable.filter((m) => !seedsOwnerRole.has(m))).toEqual([]);
  });
});
