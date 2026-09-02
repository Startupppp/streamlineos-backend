import type { CurrentUserContext } from "../auth/backend-claims";
import type { ModuleAvailabilityResult } from "./module-availability";

export const MODULE_GUARD_ACCESS = Symbol("MODULE_GUARD_ACCESS");

export interface IModuleGuardAccess {
  moduleAvailability(
    user: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleAvailabilityResult>;
}
