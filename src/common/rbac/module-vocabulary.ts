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
] as const;

export type ModuleKey = (typeof MODULE_CATALOG)[number];
