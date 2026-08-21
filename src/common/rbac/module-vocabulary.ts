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
 * A module usually owns the permission namespace that shares its name. Home is
 * the exception: chat, mail and calendar are the communication surfaces every
 * active member keeps, and they are administered by one Home ladder rather than
 * three. The mapping lives here rather than in the key strings, because
 * renaming a key would break every grant already stored against it.
 */
const MODULE_PERMISSION_NAMESPACES: Readonly<Record<string, readonly string[]>> =
  {
    home: ["chat", "mail", "calendar"],
  };

export function namespacesForModule(moduleKey: string): readonly string[] {
  return MODULE_PERMISSION_NAMESPACES[moduleKey] ?? [moduleKey];
}

export function moduleOwningNamespace(namespace: string): string {
  for (const [moduleKey, namespaces] of Object.entries(
    MODULE_PERMISSION_NAMESPACES,
  )) {
    if (namespaces.includes(namespace)) return moduleKey;
  }
  return namespace;
}
