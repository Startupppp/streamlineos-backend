import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AccessResolver } from "../access/authorize";
import type { DataScope } from "../access/access.types";
import { moduleAvailability } from "../../common/rbac/module-availability";
import { ScopedRead } from "../access/scoped-read";

export interface SearchAccess {
  leads: ScopedRead | null;
  deals: ScopedRead | null;
  contacts: ScopedRead | null;
  clients: ScopedRead | null;
  build: ScopedRead | null;
}

export async function resolveSearchAccess(
  access: AccessResolver,
  user: CurrentUserContext,
): Promise<SearchAccess> {
  let moduleMapPromise: Promise<Record<string, boolean>> | undefined;
  const memoGetModuleMap = (orgId: string): Promise<Record<string, boolean>> => {
    if (!moduleMapPromise) {
      moduleMapPromise = (async () => {
        const crmState = await access.getModuleState(orgId, "crm");
        const buildState = await access.getModuleState(orgId, "build");
        return { crm: crmState ?? false, build: buildState ?? false };
      })();
    }
    return moduleMapPromise;
  };

  const resolver = access.buildModuleAvailabilityResolver(memoGetModuleMap);
  const [[crmAvail, buildAvail], [leadScope, dealScope, contactScope, clientScope, buildScope]] =
    await Promise.all([
      Promise.all([
        moduleAvailability(resolver, user.orgId, user.userId, "crm"),
        moduleAvailability(resolver, user.orgId, user.userId, "build"),
      ]),
      Promise.all([
        access.scopeFor(user, "crm:leads:view"),
        access.scopeFor(user, "crm:deals:read"),
        access.scopeFor(user, "crm:contacts:view"),
        access.scopeFor(user, "crm:clients:read"),
        access.scopeFor(user, "build:tickets:view"),
      ]),
    ]);

  const wrap = (available: boolean, scope: DataScope): ScopedRead | null =>
    available && scope !== "none" ? ScopedRead.of(user.orgId, user.userId, scope) : null;

  return {
    leads: wrap(crmAvail.available, leadScope),
    deals: wrap(crmAvail.available, dealScope),
    contacts: wrap(crmAvail.available, contactScope),
    clients: wrap(crmAvail.available, clientScope),
    build: wrap(buildAvail.available, buildScope),
  };
}
