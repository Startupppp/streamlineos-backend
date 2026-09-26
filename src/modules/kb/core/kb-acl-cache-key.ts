import { createHash } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Principal } from "../../../common/auth/principal";
import { actingMembershipId, principalCeiling } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AccessService } from "../../access/access.service";
import {
  computeAccessibleSpaceIds,
  resolveRoleSlugs,
} from "./authorization/knowledge-space-scope";

export const KB_MANAGE_SPACES = "kb:spaces:manage";
export const KB_SPACE_SCOPE_TTL_SECONDS = 60;

export const UNBOUNDED_CEILING = "unbounded";
export const ABSENT_PRINCIPAL_KIND = "absent";

export const CEILING_BEARING_PRINCIPAL_KINDS: readonly Principal["kind"][] = [
  "personal-token",
  "agent-token",
  "system-job",
];

const CEILING_BEARING_KINDS: ReadonlySet<string> = new Set<string>(
  CEILING_BEARING_PRINCIPAL_KINDS,
);

export interface KbAclDimension {
  readonly orgId: string;
  readonly permissionsVersion: number;
  readonly membershipId: number | null;
  readonly principalKind: string;
  readonly ceilingDigest: string;
}

export function kbCeilingDigest(ceiling: readonly string[] | null): string {
  if (ceiling === null) return UNBOUNDED_CEILING;
  return createHash("sha256")
    .update([...ceiling].sort().join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

export function kbAclDimension(
  user: CurrentUserContext,
  permissionsVersion: number,
): KbAclDimension {
  const principal: Principal | undefined = user.principal;
  return {
    orgId: user.orgId,
    permissionsVersion,
    membershipId: principal === undefined ? null : actingMembershipId(principal),
    principalKind: principal === undefined ? ABSENT_PRINCIPAL_KIND : principal.kind,
    ceilingDigest: kbCeilingDigest(
      principal === undefined ? null : principalCeiling(principal),
    ),
  };
}

export function kbSpaceScopeIsAdmin(
  user: CurrentUserContext,
  holdsManageKey: boolean,
): boolean {
  if (holdsManageKey) return true;
  const principal: Principal | undefined = user.principal;
  const ceiling = principal === undefined ? null : principalCeiling(principal);
  return ceiling === null && user.isOrgOwner;
}

export function kbAclCacheKey(userId: string, acl: KbAclDimension): string {
  if (!Number.isInteger(acl.permissionsVersion) || acl.permissionsVersion < 1)
    throw new Error(
      "KB cache keys require a resolved permissionsVersion — an ACL-blind key keeps serving spaces a revoked role no longer reaches",
    );
  if (!userId) throw new Error("KB cache keys require a userId");
  if (!acl.orgId)
    throw new Error(
      "KB cache keys require an orgId — a userId is globally unique and one person can hold memberships in several organisations, so a tenant-blind key serves one org's spaces under another",
    );
  if (!acl.principalKind)
    throw new Error(
      "KB cache keys require a principalKind — an agent token and the human session that issued it resolve to the same person and membership, so a kind-blind key serves each of them the other's space list",
    );
  if (!acl.ceilingDigest)
    throw new Error(
      "KB cache keys require a ceilingDigest — a token's authority is its ceiling and not its membership record, so a ceiling-blind key serves a narrow-scoped token the full list its holder would see",
    );
  if (CEILING_BEARING_KINDS.has(acl.principalKind) && acl.ceilingDigest === UNBOUNDED_CEILING)
    throw new Error(
      `KB cache keys cannot record a ${acl.principalKind} as unbounded — that principal always carries a ceiling, and an unbounded digest would share an entry with a full-authority session`,
    );
  return `o${acl.orgId}:p${acl.permissionsVersion}:k${acl.principalKind}:c${acl.ceilingDigest}:m${acl.membershipId ?? "none"}:u${userId}`;
}

export interface KbSpaceScopeDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly access: AccessService;
}

export interface KbSpaceScopeInputs {
  readonly permissionsVersion?: number;
  readonly holdsManageKey?: boolean;
  readonly roleSlugs?: readonly string[];
}

export interface KbAccessibleSpaceScope {
  readonly spaceIds: number[];
  readonly membershipId: number | null;
  readonly isAdmin: boolean;
  readonly holdsManageKey: boolean;
  readonly permissionsVersion: number;
  readonly cacheKey: string;
}

interface PreparedSpaceScope {
  readonly acl: KbAclDimension;
  readonly cacheKey: string;
  readonly isAdmin: boolean;
  readonly holdsManageKey: boolean;
  readonly fill: () => Promise<number[]>;
}

async function prepareSpaceScope(
  deps: KbSpaceScopeDeps,
  user: CurrentUserContext,
  given: KbSpaceScopeInputs,
): Promise<PreparedSpaceScope> {
  const [holdsManageKey, permissionsVersion] = await Promise.all([
    given.holdsManageKey === undefined
      ? deps.access.holds(user, KB_MANAGE_SPACES)
      : Promise.resolve(given.holdsManageKey),
    given.permissionsVersion === undefined
      ? deps.access.getPermissionsVersion(user.orgId)
      : Promise.resolve(given.permissionsVersion),
  ]);

  const isAdmin = kbSpaceScopeIsAdmin(user, holdsManageKey);
  const acl = kbAclDimension(user, permissionsVersion);

  return {
    acl,
    cacheKey: kbAclCacheKey(user.userId, acl),
    isAdmin,
    holdsManageKey,
    fill: () =>
      computeAccessibleSpaceIds(deps.db, user.orgId, acl.membershipId, isAdmin, () =>
        given.roleSlugs === undefined
          ? resolveRoleSlugs(deps.db, user.orgId, user.userId)
          : Promise.resolve([...given.roleSlugs]),
      ),
  };
}

export async function resolveAccessibleSpaceScope(
  deps: KbSpaceScopeDeps,
  user: CurrentUserContext,
  given: KbSpaceScopeInputs = {},
): Promise<KbAccessibleSpaceScope> {
  const prepared = await prepareSpaceScope(deps, user, given);
  const spaceIds = await deps.cache.cachedVersioned(
    `kb:acc-spaces:${user.orgId}`,
    prepared.cacheKey,
    prepared.fill,
    KB_SPACE_SCOPE_TTL_SECONDS,
  );
  return {
    spaceIds,
    membershipId: prepared.acl.membershipId,
    isAdmin: prepared.isAdmin,
    holdsManageKey: prepared.holdsManageKey,
    permissionsVersion: prepared.acl.permissionsVersion,
    cacheKey: prepared.cacheKey,
  };
}

export async function resolveAccessibleSpaceScopeWithOutcome(
  deps: KbSpaceScopeDeps,
  user: CurrentUserContext,
  given: KbSpaceScopeInputs = {},
): Promise<KbAccessibleSpaceScope & { cacheOutcome: "hit" | "miss" | "bypass" }> {
  const prepared = await prepareSpaceScope(deps, user, given);
  const { value, cacheOutcome } = await deps.cache.cachedVersionedWithOutcome(
    `kb:acc-spaces:${user.orgId}`,
    prepared.cacheKey,
    prepared.fill,
    KB_SPACE_SCOPE_TTL_SECONDS,
  );
  return {
    spaceIds: value,
    membershipId: prepared.acl.membershipId,
    isAdmin: prepared.isAdmin,
    holdsManageKey: prepared.holdsManageKey,
    permissionsVersion: prepared.acl.permissionsVersion,
    cacheKey: prepared.cacheKey,
    cacheOutcome,
  };
}
