/**
 * One declaration of what a module is.
 *
 * `ladder` is three-valued rather than a boolean because "no ladder" conflates
 * two different things: a UNIVERSAL surface every active member keeps, where
 * there is no membership to appoint, and PLATFORM-ADMIN organisation
 * administration that is never delegated to a module owner. Chat is the first;
 * billing is the second. A boolean cannot tell them apart, which is part of why
 * the distinction was never written down.
 */
export type ModuleLadder = "delegable" | "universal" | "platform-admin";

export interface ModuleDefinition {
  readonly id: string;
  readonly displayName: string;
  /** Does a subscription gate it. Money only - not whether it appears anywhere. */
  readonly planGated: boolean;
  /** Does it appear on the modules and per-person access screens. Surface only - not money. */
  readonly administrable: boolean;
  readonly ladder: ModuleLadder;
  /** Permission namespaces this module administers beyond its own id. */
  readonly administersNamespaces: readonly string[];
}

const NONE: readonly string[] = [];

export const MODULE_REGISTRY = [
  { id: "hr", displayName: "HR", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "crm", displayName: "CRM", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "build", displayName: "Build", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "accounting", displayName: "Accounting", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "inventory", displayName: "Inventory", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "kb", displayName: "Knowledge Base", planGated: false, administrable: true, ladder: "universal", administersNamespaces: NONE },
  { id: "chat", displayName: "Chat", planGated: false, administrable: true, ladder: "universal", administersNamespaces: NONE },
  { id: "support", displayName: "Support", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "surveys", displayName: "Surveys", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "payroll", displayName: "Payroll", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "sign", displayName: "Sign", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "timesheets", displayName: "Timesheets", planGated: true, administrable: true, ladder: "delegable", administersNamespaces: NONE },
  { id: "workflows", displayName: "Workflows", planGated: false, administrable: false, ladder: "delegable", administersNamespaces: NONE },
  { id: "blog", displayName: "Blog", planGated: false, administrable: false, ladder: "delegable", administersNamespaces: NONE },
  { id: "directory", displayName: "Directory", planGated: false, administrable: false, ladder: "delegable", administersNamespaces: NONE },
  {
    id: "home",
    displayName: "Home",
    planGated: false,
    administrable: false,
    ladder: "universal",
    // Decided, built as a ladder, then deliberately retired: Home is universal.
    // The grouping survives as administration only, so these four namespaces
    // resolve to a module that exists rather than to nothing.
    administersNamespaces: ["chat", "mail", "calendar", "notifications"],
  },
  { id: "mail", displayName: "Mail", planGated: false, administrable: false, ladder: "universal", administersNamespaces: NONE },
  { id: "calendar", displayName: "Calendar", planGated: false, administrable: false, ladder: "universal", administersNamespaces: NONE },
  { id: "notifications", displayName: "Notifications", planGated: false, administrable: false, ladder: "universal", administersNamespaces: NONE },
  // Never delegated: organisation owner and admins only, on every path
  // including the owner's own. Must appear in neither derived list.
  { id: "billing", displayName: "Billing", planGated: false, administrable: false, ladder: "platform-admin", administersNamespaces: NONE },
] as const satisfies readonly ModuleDefinition[];

export type ModuleId = (typeof MODULE_REGISTRY)[number]["id"];

type DefinitionOf<Id extends ModuleId> = Extract<
  (typeof MODULE_REGISTRY)[number],
  { id: Id }
>;

export type PlanGatedModuleId = DefinitionOf<ModuleId> extends infer Definition
  ? Definition extends { planGated: true; id: infer Id }
    ? Id
    : never
  : never;

export type DelegableModuleId = DefinitionOf<ModuleId> extends infer Definition
  ? Definition extends { ladder: "delegable"; id: infer Id }
    ? Id
    : never
  : never;

const BY_ID = new Map<string, ModuleDefinition>(
  MODULE_REGISTRY.map((definition) => [definition.id, definition]),
);

export function moduleDefinition(id: string): ModuleDefinition | undefined {
  return BY_ID.get(id);
}

export function moduleIds(): string[] {
  return MODULE_REGISTRY.map((definition) => definition.id);
}

type RegistryEntry = (typeof MODULE_REGISTRY)[number];

export function planGatedModuleIds(): PlanGatedModuleId[] {
  return MODULE_REGISTRY.filter(
    (definition): definition is Extract<RegistryEntry, { planGated: true }> =>
      definition.planGated,
  ).map((definition) => definition.id);
}

export function delegableModuleIds(): DelegableModuleId[] {
  return MODULE_REGISTRY.filter(
    (definition): definition is Extract<RegistryEntry, { ladder: "delegable" }> =>
      definition.ladder === "delegable",
  ).map((definition) => definition.id);
}

export function additionalNamespaces(): Record<string, readonly string[]> {
  const map: Record<string, readonly string[]> = {};
  for (const definition of MODULE_REGISTRY) {
    if (definition.administersNamespaces.length > 0)
      map[definition.id] = definition.administersNamespaces;
  }
  return map;
}

/**
 * The stored enablement projection is uppercase; the catalog is lowercase.
 * Comparing them without translating is what once made every module gate throw
 * for non-owners, so the translation belongs here and nowhere else.
 */
export function storedModuleKey(id: string): string {
  return id.toUpperCase();
}

export function moduleIdFromStored(stored: string): string {
  return stored.toLowerCase();
}

/** What the modules and per-person access screens list. A core module still appears, marked core. */
export function administrableModuleIds(): string[] {
  return MODULE_REGISTRY.filter((definition) => definition.administrable).map(
    (definition) => definition.id,
  );
}

/**
 * Free and always on, which is `!planGated` — not `ladder: "universal"`.
 * Ladder answers delegation, planGated answers money: workflows, blog and directory are
 * delegable AND free, so deriving from ladder would newly plan-gate all three.
 * Billing is free to nobody and is excluded by its platform-admin ladder.
 */
export function coreModuleIds(): string[] {
  return MODULE_REGISTRY.filter(
    (definition) => !definition.planGated && definition.ladder !== "platform-admin",
  ).map((definition) => definition.id);
}
