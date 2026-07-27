export const MODULE_CATALOG = [
  "hr",
  "crm",
  "build",
  "accounting",
  "inventory",
  "kb",
  "support",
  "surveys",
  "payroll",
  "sign",
] as const;

export type ModuleKey = (typeof MODULE_CATALOG)[number];

export const MODULE_KEY_TO_ORG_MODULE: Readonly<Record<string, string>> = {
  hr: "HR",
  crm: "CRM",
  build: "PROJECTS",
  inventory: "INVENTORY",
  accounting: "FINANCE",
  support: "HELPDESK",
  surveys: "SURVEYS",
  payroll: "PAYROLL",
  sign: "SIGN",
};

export const CORE_MODULE_KEYS: ReadonlySet<string> = new Set(
  MODULE_CATALOG.filter((key) => !MODULE_KEY_TO_ORG_MODULE[key]),
);

const ORG_MODULE_TO_MODULE_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MODULE_KEY_TO_ORG_MODULE).map(([key, projection]) => [projection, key]),
);

export function moduleKeysFromOrgModuleValues(values: readonly string[]): string[] {
  const resolved = new Set<string>();
  for (const raw of values) {
    const upper = raw.trim().toUpperCase();
    if (!upper) continue;
    const lower = upper.toLowerCase();
    const key =
      ORG_MODULE_TO_MODULE_KEY[upper] ??
      (MODULE_CATALOG.some((candidate) => candidate === lower) ? lower : undefined);
    if (key && !CORE_MODULE_KEYS.has(key)) resolved.add(key);
  }
  return [...resolved];
}

