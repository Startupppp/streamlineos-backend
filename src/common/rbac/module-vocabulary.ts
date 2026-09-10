import {
  additionalNamespaces,
  administrableModuleIds,
  delegableModuleIds,
  planGatedModuleIds,
  type DelegableModuleId,
  type PlanGatedModuleId,
} from "./module-registry";

export type ModuleKey = PlanGatedModuleId;

/** Plan gating, and only that. What the screens list is ADMINISTRABLE_MODULES. */
export const MODULE_CATALOG: readonly ModuleKey[] = planGatedModuleIds();

/** What the modules and per-person access screens list, core modules included. */
export const ADMINISTRABLE_MODULES: readonly string[] = administrableModuleIds();

/** Every module whose access ladder is delegable. */
export const ACCESS_MANAGED_MODULES: readonly DelegableModuleId[] = delegableModuleIds();

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

/**
 * The key's own namespace — which module's ENTITLEMENT gates it. Not the same
 * question as `administeringModuleOf`, which answers which module's admin ladder
 * owns it: Home administers `chat:*`, but `chat` is what must be enabled.
 */
export function namespaceOf(permissionKey: string): string {
  const separatorIndex = permissionKey.indexOf(":");
  return separatorIndex === -1
    ? permissionKey
    : permissionKey.slice(0, separatorIndex);
}

export function administeringModuleOf(permissionKey: string): string {
  return moduleOwningNamespace(namespaceOf(permissionKey));
}

export function moduleOwningNamespace(namespace: string): string {
  for (const [moduleKey, namespaces] of Object.entries(
    ADDITIONAL_MODULE_NAMESPACES,
  )) {
    if (namespaces.includes(namespace)) return moduleKey;
  }
  return namespace;
}
