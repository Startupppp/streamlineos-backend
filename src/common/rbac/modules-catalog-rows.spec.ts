import { buildModulesCatalogRows } from "./modules-catalog-rows";
import { MODULE_REGISTRY, coreModuleIds } from "./module-registry";
import { MODULE_ADMIN_MODULES } from "../../modules/rbac/seed-system-roles";

describe("buildModulesCatalogRows", () => {
  it("returns exactly one row per registered module", () => {
    const rows = buildModulesCatalogRows();
    expect(rows).toHaveLength(MODULE_REGISTRY.length);
    expect(new Set(rows.map((row) => row.moduleKey)).size).toBe(rows.length);
  });

  it("mirrors each registry entry onto the catalog row shape", () => {
    const core = new Set(coreModuleIds());
    const rows = buildModulesCatalogRows();
    rows.forEach((row, index) => {
      const definition = MODULE_REGISTRY[index]!;
      expect(row.moduleKey).toBe(definition.id);
      expect(row.name).toBe(definition.displayName);
      expect(row.description).toBeNull();
      expect(row.isPaidOnly).toBe(definition.planGated);
      expect(row.isCore).toBe(core.has(definition.id));
      expect(row.sortOrder).toBe(index);
      expect(row.status).toBe("ACTIVE");
    });
  });

  it("gives sort orders that are stable and contiguous from zero", () => {
    const rows = buildModulesCatalogRows();
    expect(rows.map((row) => row.sortOrder)).toEqual(rows.map((_row, index) => index));
  });

  it("catalogues every module the seeder mints an admin role for, so no roles insert violates fk_roles_module", () => {
    const catalogued = new Set(buildModulesCatalogRows().map((row) => row.moduleKey));
    const uncatalogued = MODULE_ADMIN_MODULES.filter((mod) => !catalogued.has(mod));
    expect(uncatalogued.sort()).toEqual([]);
  });
});
