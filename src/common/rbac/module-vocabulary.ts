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
