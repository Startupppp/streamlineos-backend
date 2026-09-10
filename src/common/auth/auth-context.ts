import type { CurrentUserContext } from "./backend-claims";
import type { ModuleAvailabilityResult } from "../rbac/module-availability";

export interface ModuleAvailabilityLookup {
  moduleAvailability(
    user: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleAvailabilityResult>;
}

/** Availability is resolved once per module key and reused — ADR 0004. */
export interface AuthContext {
  readonly actor: CurrentUserContext;
  moduleAvailable(moduleKey: string): Promise<ModuleAvailabilityResult>;
}

export function createAuthContext(
  actor: CurrentUserContext,
  lookup: ModuleAvailabilityLookup,
): AuthContext {
  const resolved = new Map<string, Promise<ModuleAvailabilityResult>>();
  return {
    actor,
    moduleAvailable(moduleKey: string): Promise<ModuleAvailabilityResult> {
      const key = moduleKey.trim().toLowerCase();
      const existing = resolved.get(key);
      if (existing) return existing;
      const pending = lookup.moduleAvailability(actor, key);
      resolved.set(key, pending);
      return pending;
    },
  };
}
