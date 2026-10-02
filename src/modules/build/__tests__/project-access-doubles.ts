import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { resolvePrincipalScope } from "../../access/access-principal-scope";
import type { ProjectState } from "../core";

export type StandingScopes = Partial<Record<string, DataScope>>;

export function standingAccess(scopes: StandingScopes = {}) {
  const scopeFor = jest.fn(
    async (_actor: CurrentUserContext, key: string) => scopes[key] ?? "none",
  );
  return {
    scopeFor,
    holds: jest.fn(async (actor: CurrentUserContext, key: string) => (await scopeFor(actor, key)) !== "none"),
    resolveUserPermissions: jest.fn(async () => {
      const granted = new Map<string, DataScope>();
      for (const [key, scope] of Object.entries(scopes)) if (scope !== undefined) granted.set(key, scope);
      return granted;
    }),
  };
}

export const MEMBER_STANDING: StandingScopes = {
  "build:view": "own",
  "build:tickets:view": "all",
};

export const MANAGER_STANDING: StandingScopes = {
  "build:manage": "all",
  "build:view": "all",
  "build:tickets:view": "all",
};

export type ProjectAccessRow = {
  state: ProjectState;
  manages: boolean;
  memberRole: string | null;
  onTeam: boolean;
};

export function projectAccessRow(overrides: Partial<ProjectAccessRow> = {}): ProjectAccessRow {
  return { state: "ACTIVE", manages: false, memberRole: null, onTeam: false, ...overrides };
}

export function principalAccess(memberGrants: StandingScopes = {}) {
  const scopeFor = jest.fn(async (actor: CurrentUserContext, key: string) =>
    resolvePrincipalScope(actor.principal, key, async (isOrgOwner) =>
      isOrgOwner ? "all" : (memberGrants[key] ?? "none"),
    ),
  );
  return {
    scopeFor,
    holds: jest.fn(async (actor: CurrentUserContext, key: string) => (await scopeFor(actor, key)) !== "none"),
  };
}
