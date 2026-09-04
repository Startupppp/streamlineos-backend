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
  /** The product route the module owns ("/timesheets"), null when it owns no product surface. */
  readonly route: string | null;
  /** The frontend sidebar ProductKey for this module, null when it has none. */
  readonly productKey: string | null;
  /** The folder under src/modules/ holding the module's code, null when no dedicated folder. */
  readonly moduleFolder: string | null;
  /** The folder under src/db/schema/ holding the module's tables, null when schema lives in common. */
  readonly schemaFolder: string | null;
  /** Does the module own any handler carrying @Public(). */
  readonly publicExposure: boolean;
  /** The Redis cache namespaces (key prefixes) the module owns. */
  readonly cacheNamespaces: readonly string[];
}

export const MODULE_MANIFEST_VERSION = 1;

const NONE: readonly string[] = [];

export const MODULE_REGISTRY = [
  {
    id: "hr",
    displayName: "HR",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/hr",
    productKey: "hrms",
    moduleFolder: "hr",
    schemaFolder: "hr",
    publicExposure: true,
    cacheNamespaces: ["hr"],
  },
  {
    id: "crm",
    displayName: "CRM",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    // The party ladder is not a product of its own: a CRM administrator has to
    // be able to manage the customers their deals point at. Without this,
    // `moduleScopedPermissions("crm")` skips every `party:` key and those
    // endpoints are reachable only by an organisation admin.
    administersNamespaces: ["party"],
    route: "/crm",
    productKey: "crm",
    moduleFolder: "crm",
    schemaFolder: "crm",
    publicExposure: true,
    cacheNamespaces: ["leads", "crm", "deals", "clients", "sales", "ce", "targets", "quotes"],
  },
  {
    id: "build",
    displayName: "Build",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/build",
    productKey: "build",
    moduleFolder: "build",
    schemaFolder: "build",
    publicExposure: true,
    cacheNamespaces: ["projects", "tickets"],
  },
  {
    id: "accounting",
    displayName: "Accounting",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/accounting",
    productKey: "finance",
    moduleFolder: "accounting",
    schemaFolder: "accounting",
    publicExposure: false,
    cacheNamespaces: ["fin", "invoices"],
  },
  {
    id: "inventory",
    displayName: "Inventory",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/inventory",
    productKey: "inventory",
    moduleFolder: "inventory",
    schemaFolder: "inventory",
    publicExposure: false,
    cacheNamespaces: ["inv"],
  },
  {
    id: "kb",
    displayName: "Knowledge Base",
    planGated: false,
    administrable: true,
    ladder: "universal",
    administersNamespaces: NONE,
    route: "/knowledge",
    productKey: "documents",
    moduleFolder: "kb",
    schemaFolder: "kb",
    publicExposure: true,
    cacheNamespaces: ["kb"],
  },
  {
    id: "chat",
    displayName: "Chat",
    planGated: false,
    administrable: true,
    ladder: "universal",
    administersNamespaces: NONE,
    route: "/chat",
    productKey: null,
    moduleFolder: "chat",
    schemaFolder: "chat",
    publicExposure: false,
    cacheNamespaces: NONE,
  },
  {
    id: "support",
    displayName: "Support",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/support",
    productKey: "helpdesk",
    moduleFolder: "support",
    schemaFolder: "support",
    publicExposure: true,
    cacheNamespaces: ["support"],
  },
  {
    id: "feedbucket",
    displayName: "Feedbucket",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: null,
    productKey: null,
    moduleFolder: "feedbucket",
    schemaFolder: null,
    publicExposure: true,
    cacheNamespaces: NONE,
  },
  {
    id: "surveys",
    displayName: "Surveys",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/surveys",
    productKey: "surveys",
    moduleFolder: "surveys",
    schemaFolder: "surveys",
    publicExposure: true,
    cacheNamespaces: NONE,
  },
  {
    id: "payroll",
    displayName: "Payroll",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/payroll",
    productKey: "payroll",
    moduleFolder: "payroll",
    schemaFolder: "payroll",
    publicExposure: false,
    cacheNamespaces: NONE,
  },
  {
    id: "sign",
    displayName: "Sign",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/sign",
    productKey: "sign",
    moduleFolder: "e-sign",
    schemaFolder: "e-sign",
    publicExposure: true,
    cacheNamespaces: NONE,
  },
  {
    id: "timesheets",
    displayName: "Timesheets",
    planGated: true,
    administrable: true,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/timesheets",
    productKey: "timesheets",
    moduleFolder: "timesheets",
    schemaFolder: "timesheets",
    publicExposure: false,
    cacheNamespaces: ["timesheets"],
  },
  {
    id: "workflows",
    displayName: "Workflows",
    planGated: false,
    administrable: false,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/workflows",
    productKey: null,
    moduleFolder: "workflows",
    schemaFolder: null,
    publicExposure: true,
    cacheNamespaces: NONE,
  },
  {
    id: "blog",
    displayName: "Blog",
    planGated: false,
    administrable: false,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/blog",
    productKey: null,
    moduleFolder: "blog",
    schemaFolder: "blog",
    publicExposure: true,
    cacheNamespaces: NONE,
  },
  {
    id: "directory",
    displayName: "Directory",
    planGated: false,
    administrable: false,
    ladder: "delegable",
    administersNamespaces: NONE,
    route: "/directory",
    productKey: null,
    moduleFolder: "directory",
    schemaFolder: "directory",
    publicExposure: false,
    cacheNamespaces: NONE,
  },
  // Tasks are a universal member surface: `tasks:read` ships in
  // EMPLOYEE_SELF_SERVICE, TasksController carries no @RequireModule, and no
  // plan locks it. It is declared here rather than left absent because absence
  // is not a statement — `isCoreModuleKey` answers "core" for any key it does
  // not hold, so an undeclared module reads as free by accident and nobody has
  // decided anything. Not administrable and not delegable: there is no tasks
  // ladder to appoint and no org toggle to show.
  {
    id: "tasks",
    displayName: "Tasks",
    planGated: false,
    administrable: false,
    ladder: "universal",
    administersNamespaces: NONE,
    route: null,
    productKey: null,
    moduleFolder: "tasks",
    schemaFolder: null,
    publicExposure: false,
    cacheNamespaces: NONE,
  },
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
    route: "/dashboard",
    productKey: "home",
    moduleFolder: "dashboard",
    schemaFolder: null,
    publicExposure: false,
    cacheNamespaces: ["dashboard"],
  },
  {
    id: "mail",
    displayName: "Mail",
    planGated: false,
    administrable: false,
    ladder: "universal",
    administersNamespaces: NONE,
    route: "/mail",
    productKey: null,
    moduleFolder: "mail",
    schemaFolder: "mail",
    publicExposure: false,
    cacheNamespaces: ["mail"],
  },
  {
    id: "calendar",
    displayName: "Calendar",
    planGated: false,
    administrable: false,
    ladder: "universal",
    administersNamespaces: NONE,
    route: "/calendar",
    productKey: null,
    moduleFolder: "calendar",
    schemaFolder: "calendar",
    publicExposure: false,
    cacheNamespaces: ["calendar"],
  },
  {
    id: "notifications",
    displayName: "Notifications",
    planGated: false,
    administrable: false,
    ladder: "universal",
    administersNamespaces: NONE,
    route: "/notifications",
    productKey: null,
    moduleFolder: "notifications",
    schemaFolder: null,
    publicExposure: true,
    cacheNamespaces: NONE,
  },
  // Never delegated: organisation owner and admins only, on every path
  // including the owner's own. Must appear in neither derived list.
  {
    id: "settings",
    displayName: "Settings",
    planGated: false,
    administrable: false,
    ladder: "platform-admin",
    administersNamespaces: NONE,
    route: "/settings",
    productKey: null,
    moduleFolder: "settings",
    schemaFolder: null,
    publicExposure: false,
    cacheNamespaces: NONE,
  },
  {
    id: "billing",
    displayName: "Billing",
    planGated: false,
    administrable: false,
    ladder: "platform-admin",
    administersNamespaces: NONE,
    route: null,
    productKey: null,
    moduleFolder: "billing",
    schemaFolder: "billing",
    publicExposure: true,
    cacheNamespaces: NONE,
  },
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

/**
 * The one availability definition for a module that is always on.
 *
 * The argument is a PERMISSION NAMESPACE, not necessarily a module. Thirteen
 * live namespaces own permissions without being modules (ai, audit-log, branch,
 * dashboard, integrations, onboarding, ownership, payments, reports, sales,
 * self, storage, and party via CRM), and `moduleOf` hands this function the raw
 * segment before the first colon, so refusing an unknown key would answer
 * NO_MODULE for every permission in all of them. Unknown-is-core is therefore
 * deliberate and load-bearing; `administering-module-exists.spec.ts` pins the
 * exact set so a fourteenth is a decision rather than a discovery.
 *
 * A caller asking about a MODULE — something an organisation enables, is billed
 * for, or toggles — must therefore establish `moduleDefinition(key)` first.
 * Passing an undeclared key here means "not plan-gated", never "declared core".
 *
 * Registered modules are core only when they are not subscription-gated and are
 * not platform-admin-only. The platform-admin ladder controls delegation, not
 * availability, so billing is still always available to its platform users.
 */
export function isCoreModuleKey(rawKey: string): boolean {
  const key = moduleIdFromStored(rawKey);
  const definition = moduleDefinition(key);
  return (
    definition === undefined ||
    !definition.planGated
  );
}
