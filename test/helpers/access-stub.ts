import { moduleAvailabilityResolver } from "src/common/rbac/module-availability";
import type { DataScope } from "src/modules/access/access.types";
import type { CurrentUserContext } from "src/common/auth/backend-claims";

type PermissionMap = Map<string, DataScope>;

interface PermissionSource {
  resolveUserPermissions: (...args: never[]) => Promise<PermissionMap>;
}

export function withAccessResolution<T extends PermissionSource>(stub: T) {
  const permissions = (): Promise<PermissionMap> =>
    (stub.resolveUserPermissions as () => Promise<PermissionMap>)();

  return {
    ...stub,
    getModuleState: async (): Promise<boolean> => true,
    buildModuleAvailabilityResolver: (
      getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
    ) =>
      moduleAvailabilityResolver({
        isCoreModule: (): boolean => false,
        getModuleMap,
        getPlanLockedModules: async (): Promise<string[]> => [],
      }),
    scopeFor: async (_user: CurrentUserContext, key: string): Promise<DataScope> =>
      (await permissions()).get(key) ?? "none",
    holds: async (_user: CurrentUserContext, key: string): Promise<boolean> =>
      (await permissions()).has(key),
  };
}
