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

/**
 * A module always owns its own namespace, and may administer others. Home is
 * the exception that needs the map: chat, mail and calendar are the
 * communication surfaces every active member keeps, and they are administered
 * by one Home ladder rather than three. The mapping lives here rather than in
 * the key strings, because renaming a key would break every grant already
 * stored against it.
 */
const ADDITIONAL_MODULE_NAMESPACES: Readonly<
  Record<string, readonly string[]>
> = {
  home: ["chat", "mail", "calendar", "notifications"],
};

export function namespacesForModule(moduleKey: string): readonly string[] {
  const additional = ADDITIONAL_MODULE_NAMESPACES[moduleKey];
  return additional ? [moduleKey, ...additional] : [moduleKey];
}

/** The module that administers `permissionKey`, which is not always its first segment. */
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
