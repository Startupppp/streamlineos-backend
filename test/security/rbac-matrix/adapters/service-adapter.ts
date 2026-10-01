import { runWithTenantContext } from "src/common/tenant/tenant-context";
import type { CacheService } from "src/common/cache/cache.service";
import type { AuditService } from "src/common/audit/audit.service";
import type { PlanLimitsService } from "src/modules/billing/core/plan-limits.service";
import type { NotificationDispatchService } from "src/modules/notifications/notification-dispatch.service";
import { assertModuleAccessPolicy, moduleAccessPolicyDeps } from "src/modules/module-access/module-access.helpers";
import { ModuleStandingMutationsService } from "src/modules/module-access/module-standing-mutations.service";
import { RoleMemberService } from "src/modules/rbac/role-member.service";
import { RecruitmentJobsService } from "src/modules/hr/recruitment/recruitment-jobs.service";
import { assertProjectAccess, assertTicketReadAccess } from "src/modules/build/core/project-crud/project-access";
import { settle } from "../matrix-runner";
import type { Observation } from "../matrix.types";
import { MATRIX_MODULE, accessFor, actorFor, type Standing } from "../standings";
import { boundValues, standIn, type WorldDb } from "../world-db";

const cache = standIn<CacheService>({
  invalidate: async () => undefined,
  invalidateMany: async () => undefined,
  invalidateNamespace: async () => undefined,
  invalidateNamespaceForOrg: async () => undefined,
  cachedVersioned: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
});

const audit = standIn<AuditService>({ log: () => undefined });

export function inTenant<T>(world: WorldDb, orgId: string, work: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ orgId, audience: "INTERNAL", tx: world.tx, afterCommit: [] }, work);
}

function writesSince(world: WorldDb, mark: number, table: string): number {
  return world.writes.slice(mark).filter((write) => write.table === table).length;
}

export async function moduleAccessManage(world: WorldDb, standing: Standing, orgId: string): Promise<Observation> {
  const deps = moduleAccessPolicyDeps(world.db, accessFor(world));
  return settle(() => assertModuleAccessPolicy(deps, actorFor(standing, orgId), MATRIX_MODULE, "manage"));
}

export async function moduleStanding(
  world: WorldDb,
  verb: "grant" | "revoke",
  standing: Standing,
  orgId: string,
  targetMembershipId: number,
): Promise<Observation> {
  const service = new ModuleStandingMutationsService(world.db, accessFor(world), cache, audit);
  const actor = actorFor(standing, orgId);
  const mark = world.writes.length;
  return settle(
    () =>
      inTenant(world, orgId, () =>
        verb === "grant"
          ? service.grantAdminStanding(actor, MATRIX_MODULE, targetMembershipId)
          : service.revokeStanding(actor, MATRIX_MODULE, targetMembershipId),
      ),
    (value) => ({
      writesOnlyWhenAllowed: (value === undefined) === (writesSince(world, mark, "role_assignments") === 0),
    }),
  );
}

export async function roleMemberAdd(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  roleId: number,
  principalId: string,
): Promise<Observation> {
  const dispatch = standIn<NotificationDispatchService>({ emit: async () => ({ delivered: 0 }) });
  const service = new RoleMemberService(world.db, cache, audit, dispatch, accessFor(world));
  const mark = world.writes.length;
  return settle(
    () => inTenant(world, orgId, () => service.addRoleMember(actorFor(standing, orgId), roleId, { principalType: "user", principalId })),
    (value) => ({
      writesOnlyWhenAllowed: (value === undefined) === (writesSince(world, mark, "role_assignments") === 0),
    }),
  );
}

export async function projectAccess(world: WorldDb, standing: Standing, orgId: string, projectId: number): Promise<Observation> {
  const mark = world.reads.length;
  return settle(
    () => assertProjectAccess(world.db, accessFor(world), actorFor(standing, orgId), projectId),
    () => ({ projectLookupRan: world.reads.slice(mark).some((read) => read.table === "projects") }),
  );
}

export async function projectWrite(
  world: WorldDb,
  orgId: string,
  write: (orgId: string) => Promise<unknown>,
): Promise<Observation> {
  const mark = world.writes.length;
  return settle(
    () => write(orgId),
    (value) => ({ insertsOnlyWhenAllowed: (value === undefined) === (world.writes.length === mark) }),
  );
}

export async function ticketRead(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  projectId: number,
  ticketId: number,
): Promise<Observation> {
  return settle(() => assertTicketReadAccess(world.db, accessFor(world), actorFor(standing, orgId), projectId, ticketId));
}

export async function recruiterRemoval(
  world: WorldDb,
  callerOrg: string,
  victimOrg: string,
  jobId: number,
  recruiterUserId: string,
): Promise<Observation> {
  const planLimits = standIn<PlanLimitsService>({ assertWithinLimit: async () => undefined });
  const service = new RecruitmentJobsService(world.db, cache, planLimits, standIn({}), standIn({}));
  const readMark = world.reads.length;
  const writeMark = world.writes.length;
  return settle(
    () => service.removeRecruiter(callerOrg, jobId, { userId: recruiterUserId }),
    (value) => {
      const lookups = world.reads.slice(readMark).filter((read) => read.table === "job_postings");
      const lookupBound = lookups.flatMap((read) => boundValues(read.where));
      const deletes = world.writes.slice(writeMark).filter((write) => write.verb === "delete");
      const deleteBound = deletes.flatMap((write) => boundValues(write.where));
      return {
        exactlyOneOwnershipLookup: lookups.length === 1,
        lookupBindsCallerOrgAndJob: lookupBound.includes(callerOrg) && lookupBound.includes(jobId),
        lookupNeverBindsVictimOrg: callerOrg === victimOrg || !lookupBound.includes(victimOrg),
        deletesOnlyWhenAllowed: (value === undefined) === (deletes.length === 0),
        deleteBindsJobAndRecruiter:
          deletes.length === 0 || (deleteBound.includes(jobId) && deleteBound.includes(recruiterUserId)),
        reportsSuccess:
          value === undefined || (typeof value === "object" && value !== null && "success" in value && value.success === true),
      };
    },
  );
}
