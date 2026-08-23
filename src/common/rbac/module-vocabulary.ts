import {
  additionalNamespaces,
  planGatedModuleIds,
  type PlanGatedModuleId,
} from "./module-registry";

export type ModuleKey = PlanGatedModuleId;

/** Computed from the registry. Nothing here is authored twice. */
export const MODULE_CATALOG: readonly ModuleKey[] = planGatedModuleIds();

const PLAN_GATED_MODULES: ReadonlySet<string> = new Set<string>(MODULE_CATALOG);

export function isPlanGatedModule(module: string): boolean {
  return PLAN_GATED_MODULES.has(module);
}

const ADDITIONAL_MODULE_NAMESPACES: Readonly<Record<string, readonly string[]>> =
  additionalNamespaces();

export function namespacesForModule(moduleKey: string): readonly string[] {
  const additional = ADDITIONAL_MODULE_NAMESPACES[moduleKey];
  return additional ? [moduleKey, ...additional] : [moduleKey];
}

export function administeringModuleOf(permissionKey: string): string {
  const separatorIndex = permissionKey.indexOf(":");
  return moduleOwningNamespace(
    separatorIndex === -1
      ? permissionKey
      : permissionKey.slice(0, separatorIndex),
  );
}

export function moduleOwningNamespace(namespace: string): string {
  for (const [moduleKey, namespaces] of Object.entries(
    ADDITIONAL_MODULE_NAMESPACES,
  )) {
    if (namespaces.includes(namespace)) return moduleKey;
  }
  return namespace;
}
