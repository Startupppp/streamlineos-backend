import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODULE_ADMIN_MODULES } from "../seed-system-roles";

/**
 * A module in `MODULE_ADMIN_MODULES` that has no `modules_catalog` row does not
 * degrade — it aborts organisation creation.
 *
 * `seedSystemRolesForOrg` mints `<MODULE>_MODULE_ADMIN` for every entry and
 * writes the module id into `roles.module_key`, which migration `0634` gave a
 * foreign key to `modules_catalog.module_key`. `NOT VALID` skips the existing
 * rows, not new inserts, so the first `INSERT INTO roles` for an uncatalogued
 * module raises `23503` — and `OrgProfileService.createOrganization` calls the
 * seeder inside the creation transaction, so the whole organisation rolls back.
 *
 * That is not hypothetical. Registering `feedbucket` (`600b9b7c`) added it to
 * the registry as plan-gated and delegable, which puts it in
 * `MODULE_ADMIN_MODULES`, and shipped no migration for the catalog row.
 * Reproduced on a scratch database built from the migration chain:
 *
 *   insert or update on table "roles" violates foreign key constraint
 *   "fk_roles_module"
 *   Key (module_key)=(feedbucket) is not present in table "modules_catalog".
 *
 * Nothing else catches it: `administering-module-exists.spec.ts` checks the
 * registry against itself, and every spec that touches the seeder mocks the
 * database, so the constraint is never exercised.
 */
describe("every module the seeder mints a role for exists in modules_catalog", () => {
  const migrationsDir = join(__dirname, "../../../../migrations");

  /** Every `module_key` any migration inserts. No migration deletes one. */
  function cataloguedModules(): Set<string> {
    const catalogued = new Set<string>();
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      for (const statement of sql.match(/INSERT\s+INTO\s+"?modules_catalog"?[\s\S]*?;/gi) ?? [])
        for (const tuple of statement.matchAll(/\(\s*'([a-z0-9_-]+)'\s*,/g))
          catalogued.add(tuple[1]!);
    }
    return catalogued;
  }

  it("finds the migrations that seed the catalog", () => {
    expect(cataloguedModules().size).toBeGreaterThan(10);
  });

  it("has a catalog row for every module an organisation is seeded a ladder for", () => {
    const catalogued = cataloguedModules();
    const uncatalogued = MODULE_ADMIN_MODULES.filter((mod) => !catalogued.has(mod));

    expect(uncatalogued.sort()).toEqual([]);
  });
});
