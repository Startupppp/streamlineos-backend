export const MODULE_CATALOG = [
  "hr",
  "crm",
  "build",
  "accounting",
  "inventory",
  "kb",
  "chat",
  "support",
  "surveys",
  "payroll",
  "sign",
  "timesheets",
] as const;

export type ModuleKey = (typeof MODULE_CATALOG)[number];

const PLAN_GATED_MODULES: ReadonlySet<string> = new Set(MODULE_CATALOG);


export function isPlanGatedModule(module: string): boolean {
  return PLAN_GATED_MODULES.has(module);
}

// Home administers chat, mail, calendar and notifications through one ladder
// rather than four; the mapping lives here rather than in the key strings
// because renaming a key breaks every stored grant. Always use
// administeringModuleOf() to resolve ownership — split(":")[0] gives the wrong
// answer for any key in a non-native namespace.
const ADDITIONAL_MODULE_NAMESPACES: Readonly<
  Record<string, readonly string[]>
> = {
  home: ["chat", "mail", "calendar", "notifications"],
};

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
