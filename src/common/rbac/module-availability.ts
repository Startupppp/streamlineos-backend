export type ModuleAvailabilityReason = "not-in-plan" | "org-disabled" | "user-denied";

export type ModuleAvailabilityResult =
  | { available: true }
  | { available: false; reason: ModuleAvailabilityReason };

/**
 * Provides the six cached inputs that determine whether a module is available.
 * Every method reads from an already-cached source; this function adds no new
 * per-request queries.
 */
export interface ModuleAvailabilityResolver {
  isCoreModule(moduleKey: string): boolean;
  getModuleMap(orgId: string): Promise<Record<string, boolean>>;
  getUserDeniedModules(orgId: string, userId: string): Promise<Set<string>>;
  getPlanLockedModules(orgId: string): Promise<readonly string[]>;
}

/**
 * Single answer to "is this module available to this user in this org".
 *
 * Resolution order:
 * 1. Core modules are always available — no deny or org row can remove them.
 * 2. An explicit user deny in `user_module_access` blocks access.
 * 3. An enabled `org_modules` row grants access regardless of the current plan
 *    (an org that enabled a module before a downgrade keeps it).
 * 4. A disabled row means org-disabled.
 * 5. No row at all: plan-locked → not-in-plan; otherwise → org-disabled.
 */
export async function moduleAvailability(
  resolver: ModuleAvailabilityResolver,
  orgId: string,
  userId: string,
  rawModuleKey: string,
): Promise<ModuleAvailabilityResult> {
  // Entitlement rows are normalized at the persistence seam. Normalize here
  // as well so guards, snapshots, and authorization share one key space even
  // when a caller supplies a stored-style key such as `HR`.
  const moduleKey = rawModuleKey.toLowerCase();
  if (resolver.isCoreModule(moduleKey)) return { available: true };

  const [denied, map] = await Promise.all([
    resolver.getUserDeniedModules(orgId, userId),
    resolver.getModuleMap(orgId),
  ]);

  if (denied.has(moduleKey) || denied.has(rawModuleKey))
    return { available: false, reason: "user-denied" };

  const orgEnabled = map[moduleKey];
  if (orgEnabled === true) return { available: true };
  if (orgEnabled === false) return { available: false, reason: "org-disabled" };

  const locked = await resolver.getPlanLockedModules(orgId);
  if (locked.includes(moduleKey)) return { available: false, reason: "not-in-plan" };
  return { available: false, reason: "org-disabled" };
}

export interface ModuleAvailabilitySources {
  isCoreModule(moduleKey: string): boolean;
  getModuleMap(orgId: string): Promise<Record<string, boolean>>;
  getPlanLockedModules(orgId: string): Promise<readonly string[]>;
}

export interface UserModuleDenies {
  getUserDeniedModules(orgId: string, userId: string): Promise<Set<string>>;
}

/** One resolver, so a second caller cannot answer availability a fourth way. */
export function moduleAvailabilityResolver(
  entitlements: ModuleAvailabilitySources,
  denies?: UserModuleDenies,
): ModuleAvailabilityResolver {
  return {
    isCoreModule: (key) => entitlements.isCoreModule(key),
    getModuleMap: (orgId) => entitlements.getModuleMap(orgId),
    getUserDeniedModules: denies
      ? (orgId, userId) => denies.getUserDeniedModules(orgId, userId)
      : async () => new Set<string>(),
    getPlanLockedModules: (orgId) => entitlements.getPlanLockedModules(orgId),
  };
}
