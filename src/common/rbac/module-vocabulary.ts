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

// RUNTIME ENTITLEMENT: which module must be enabled/undenied. Home administers `chat:*` and is always on, so never substitute `administeringModuleOf`.
export function namespaceOf(permissionKey: string): string {
  const separatorIndex = permissionKey.indexOf(":");
  return separatorIndex === -1
    ? permissionKey
    : permissionKey.slice(0, separatorIndex);
}

// ADMINISTRATION: whose admin ladder configures the key. Never decides entitlement — see `namespaceOf`.
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

const VIEW_ACTIONS = ["view", "read"] as const;

// Sibling read key at any arity: the catalog holds 2-, 3- and 4-segment keys and both `view` and `read`, so this reads the LAST segment, never a fixed position.
export function impliedViewKey(
  catalog: ReadonlySet<string>,
  permissionKey: string,
): string | null {
  const parts = permissionKey.split(":");
  if (parts.length < 2) return null;
  const action = parts[parts.length - 1];
  if (!action || VIEW_ACTIONS.some((verb) => verb === action)) return null;
  const prefix = parts.slice(0, -1);
  for (const verb of VIEW_ACTIONS) {
    const candidate = [...prefix, verb].join(":");
    if (catalog.has(candidate)) return candidate;
  }
  return null;
}

// DISPLAY ONLY: reads the leading segments verbatim and resolves no ownership.
export function permissionAreaLabel(permissionKey: string): string {
  return permissionKey.split(":").slice(0, 2).join(" ");
}
