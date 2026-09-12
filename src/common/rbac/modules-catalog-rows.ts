import { modulesCatalog } from "../../db/schema";
import { MODULE_REGISTRY, coreModuleIds } from "./module-registry";

export type ModulesCatalogRow = typeof modulesCatalog.$inferInsert;

export function buildModulesCatalogRows(): ModulesCatalogRow[] {
  const core = new Set(coreModuleIds());
  return MODULE_REGISTRY.map((definition, index) => ({
    moduleKey: definition.id,
    name: definition.displayName,
    description: null,
    isCore: core.has(definition.id),
    isPaidOnly: definition.planGated,
    sortOrder: index,
    status: "ACTIVE",
  }));
}
