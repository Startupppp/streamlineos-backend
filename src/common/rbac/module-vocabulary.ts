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

export function orgModuleAliasesFor(moduleKey: string): string[] {
  const normalized = moduleKey.toUpperCase();
  const projection = MODULE_KEY_TO_ORG_MODULE[moduleKey.toLowerCase()];
  if (!projection || projection === normalized) return [normalized];
  return [normalized, projection];
}
