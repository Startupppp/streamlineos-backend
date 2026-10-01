import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  auditLogs,
  groupRoleAssignments,
  organizationMembers,
  principalGroupMembers,
  roleAssignments,
} from "../../db/schema";
import { getObservabilityContext } from "../observability/observability-context";
import { getImpersonationContext } from "../impersonation/impersonation-context";
import { registerAfterCommit } from "../tenant/tenant-context";
import {
  bustMembershipStatusCache,
  bustMembershipStatusCacheMany,
} from "../auth/membership-state.service";
import type { CacheService } from "../cache/cache.service";
import { CACHE_KEYS, type ExactCacheKey } from "../cache/cache-keys";
import { bumpPermissionsVersion, type DbOrTx } from "./access-invalidate";

export type { DbOrTx };

export const REVOCATION_PAGE_SIZE = 100;

type AccessCommitActorFields =
  | { userId: string; systemActor?: never }
  | { userId?: null; systemActor: string };

export type CommitAccessAudit = AccessCommitActorFields & {
  action: string;
  targetId?: string | null;
  targetType?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
};

export type SessionRevoker = { revokeAllForUser(userId: string): Promise<unknown> };

export type AccessLoss =
  | { kind: "permissions"; userIds: readonly string[] }
  | { kind: "role-holders"; roleId: number }
  | { kind: "memberships"; membershipIds: readonly number[] }
  | { kind: "group-members"; groupId: string }
  | { kind: "standing"; userIds: readonly string[] }
  | { kind: "identity"; userId: string; sessions: SessionRevoker };

export interface AccessRevocation {
  cache: CacheService;
  loses: readonly AccessLoss[];
  listKeys?: readonly ExactCacheKey[];
}

export interface CommitAccessOpts<E = never> {
  audit?: CommitAccessAudit;
  revoke?: AccessRevocation;
  notify?: { via: { emit(event: E): Promise<unknown> }; events: readonly E[] };
  afterCommit?: () => Promise<void>;
}

async function afterCommitOrInline(work: () => Promise<void>): Promise<void> {
  if (!registerAfterCommit(work)) await work();
}

function buildAuditMetadata(entry: CommitAccessAudit): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry.metadata };
  if (entry.userId == null && entry.systemActor) out.systemActor = entry.systemActor;
  const impersonation = getImpersonationContext();
  if (impersonation) {
    out.impersonatedBy = impersonation.realActorUserId;
    out.impersonationSessionId = impersonation.impersonationSessionId;
  }
  return out;
}

async function writeAudit(tx: DbOrTx, orgId: string, entry: CommitAccessAudit): Promise<void> {
  const obs = getObservabilityContext();
  await tx.insert(auditLogs).values({
    action: entry.action,
    userId: entry.userId ?? null,
    orgId,
    targetId: entry.targetId ?? null,
    targetType: entry.targetType ?? entry.resourceType ?? null,
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    metadata: buildAuditMetadata(entry),
    ipAddress: obs?.ipAddress ?? null,
    isPlatformEvent: false,
  });
}

type MemberPageRow = { membershipId: number; userId: string };

async function collectMemberPages(
  fetchPage: (afterMembershipId: number, limit: number) => Promise<MemberPageRow[]>,
): Promise<string[]> {
  const userIds: string[] = [];
  let afterMembershipId = 0;
  for (;;) {
    const page = await fetchPage(afterMembershipId, REVOCATION_PAGE_SIZE);
    for (const row of page) userIds.push(row.userId);
    const last = page[page.length - 1];
    if (page.length < REVOCATION_PAGE_SIZE || !last) return userIds;
    afterMembershipId = last.membershipId;
  }
}

const memberPageColumns = {
  membershipId: organizationMembers.id,
  userId: organizationMembers.userId,
};

function resolveDirectRoleHolders(tx: DbOrTx, orgId: string, roleId: number) {
  return collectMemberPages((after, limit) =>
    tx
      .select(memberPageColumns)
      .from(roleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(organizationMembers.id, roleAssignments.organizationMembershipId),
        ),
      )
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          eq(roleAssignments.roleId, roleId),
          gt(organizationMembers.id, after),
        ),
      )
      .orderBy(asc(organizationMembers.id))
      .limit(limit),
  );
}

async function resolveGroupMembers(
  tx: DbOrTx,
  orgId: string,
  groupIds: readonly string[],
): Promise<string[]> {
  if (groupIds.length === 0) return [];
  return collectMemberPages((after, limit) =>
    tx
      .select(memberPageColumns)
      .from(principalGroupMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, principalGroupMembers.orgId),
          eq(organizationMembers.id, principalGroupMembers.organizationMembershipId),
        ),
      )
      .where(
        and(
          eq(principalGroupMembers.orgId, orgId),
          inArray(principalGroupMembers.principalGroupId, [...groupIds]),
          gt(organizationMembers.id, after),
        ),
      )
      .orderBy(asc(organizationMembers.id))
      .limit(limit),
  );
}

async function resolveRoleHolders(
  tx: DbOrTx,
  orgId: string,
  roleId: number,
): Promise<string[]> {
  const direct = await resolveDirectRoleHolders(tx, orgId, roleId);
  const groups = await tx
    .select({ groupId: groupRoleAssignments.principalGroupId })
    .from(groupRoleAssignments)
    .where(and(eq(groupRoleAssignments.orgId, orgId), eq(groupRoleAssignments.roleId, roleId)));
  const viaGroups = await resolveGroupMembers(
    tx,
    orgId,
    groups.map((row) => row.groupId),
  );
  return [...direct, ...viaGroups];
}

async function resolveMembershipUsers(
  tx: DbOrTx,
  orgId: string,
  membershipIds: readonly number[],
): Promise<string[]> {
  if (membershipIds.length === 0) return [];
  const rows = await tx
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.id, [...membershipIds]),
      ),
    );
  return rows.map((row) => row.userId);
}

async function resolveLosers(
  tx: DbOrTx,
  orgId: string,
  loss: Extract<AccessLoss, { kind: "role-holders" | "memberships" | "group-members" }>,
): Promise<string[]> {
  if (loss.kind === "role-holders") return resolveRoleHolders(tx, orgId, loss.roleId);
  if (loss.kind === "group-members") return resolveGroupMembers(tx, orgId, [loss.groupId]);
  return resolveMembershipUsers(tx, orgId, loss.membershipIds);
}

interface RevocationPlan {
  standing: readonly string[];
  sessions: readonly string[];
  listKeys: readonly ExactCacheKey[];
}

async function bustKeys(cache: CacheService, keys: readonly ExactCacheKey[]): Promise<void> {
  const [only] = keys;
  if (keys.length === 1 && only !== undefined) await cache.invalidate(only);
  else if (keys.length > 1) await cache.invalidateMany(keys);
}

async function bustStanding(cache: CacheService, userIds: readonly string[]): Promise<void> {
  const [only] = userIds;
  if (userIds.length === 1 && only !== undefined) await bustMembershipStatusCache(cache, only);
  else if (userIds.length > 1) await bustMembershipStatusCacheMany(cache, userIds);
}

async function scheduleRevocation(cache: CacheService, plan: RevocationPlan): Promise<void> {
  const keys = [
    ...new Set([...plan.listKeys, ...plan.sessions.map((id) => CACHE_KEYS.userSession(id))]),
  ];
  const standing = [...new Set(plan.standing)];
  if (keys.length === 0 && standing.length === 0) return;
  await afterCommitOrInline(async () => {
    await bustKeys(cache, keys);
    await bustStanding(cache, standing);
  });
}

export function scheduleStandingRevocation(
  cache: CacheService,
  userIds: readonly string[],
): Promise<void> {
  return scheduleRevocation(cache, { standing: userIds, sessions: [], listKeys: [] });
}

async function revokeAccess(
  tx: DbOrTx,
  orgId: string,
  revocation: AccessRevocation,
): Promise<void> {
  const sessionUsers = new Set<string>();
  const standingUsers = new Set<string>();
  for (const loss of revocation.loses) {
    if (loss.kind === "identity") {
      await loss.sessions.revokeAllForUser(loss.userId);
      standingUsers.add(loss.userId);
      continue;
    }
    if (loss.kind === "standing") {
      for (const userId of loss.userIds) {
        standingUsers.add(userId);
        sessionUsers.add(userId);
      }
      continue;
    }
    const userIds =
      loss.kind === "permissions" ? loss.userIds : await resolveLosers(tx, orgId, loss);
    for (const userId of userIds) sessionUsers.add(userId);
  }
  await scheduleRevocation(revocation.cache, {
    standing: [...standingUsers],
    sessions: [...sessionUsers],
    listKeys: revocation.listKeys ?? [],
  });
}

export async function commitAccessChange<E = never>(
  tx: DbOrTx,
  orgId: string,
  opts?: CommitAccessOpts<E>,
): Promise<void> {
  await bumpPermissionsVersion(tx, orgId);
  if (opts?.audit) await writeAudit(tx, orgId, opts.audit);
  if (opts?.revoke) await revokeAccess(tx, orgId, opts.revoke);
  if (opts?.notify)
    for (const event of opts.notify.events) await opts.notify.via.emit(event);
  if (opts?.afterCommit) await afterCommitOrInline(opts.afterCommit);
}
