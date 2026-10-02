import { runWithTenantContext } from "src/common/tenant/tenant-context";
import type { PlanLimitsService } from "src/modules/billing/core/plan-limits.service";
import { assertModuleAccessPolicy, moduleAccessPolicyDeps } from "src/modules/module-access/module-access.helpers";
import { ModuleStandingMutationsService } from "src/modules/module-access/module-standing-mutations.service";
import { RecruitmentJobsService } from "src/modules/hr/recruitment/recruitment-jobs.service";
import { assertProjectAccess, assertTicketReadAccess } from "src/modules/build/core";
import { settle } from "../matrix-runner";
import type { Observation } from "../matrix.types";
import { MATRIX_MODULE, accessFor, actorFor, type Standing, type Variant } from "../standings";
import { boundValues, standIn, type WorldDb } from "../world-db";
import { cache, milestonesService, roleMemberService } from "./real-services";

export function inTenant<T>(world: WorldDb, orgId: string, work: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ orgId, audience: "INTERNAL", tx: world.tx, afterCommit: [] }, work);
}

function writesSince(world: WorldDb, mark: number, table: string): number {
  return world.writes.slice(mark).filter((write) => write.table === table).length;
}

function writeGate(world: WorldDb, mark: number, table: string): (value: unknown) => Readonly<Record<string, boolean>> {
  return (value) => ({ writesOnlyWhenAllowed: (value === undefined) === (writesSince(world, mark, table) === 0) });
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
  const service = new ModuleStandingMutationsService(world.db, accessFor(world), cache);
  const actor = actorFor(standing, orgId);
  const mark = world.writes.length;
  return settle(
    () =>
      inTenant(world, orgId, () =>
        verb === "grant"
          ? service.grantAdminStanding(actor, MATRIX_MODULE, targetMembershipId)
          : service.revokeStanding(actor, MATRIX_MODULE, targetMembershipId),
      ),
    writeGate(world, mark, "role_assignments"),
  );
}

export async function roleMemberAdd(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  roleId: number,
  principalId: string,
): Promise<Observation> {
  const service = roleMemberService(world);
  const mark = world.writes.length;
  return settle(
    () => inTenant(world, orgId, () => service.addRoleMember(actorFor(standing, orgId), roleId, { principalType: "user", principalId })),
    writeGate(world, mark, "role_assignments"),
  );
}

export async function projectAccess(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  projectId: number,
  variant?: Variant,
): Promise<Observation> {
  const mark = world.reads.length;
  return settle(
    () => assertProjectAccess(world.db, accessFor(world), actorFor(standing, orgId, variant), projectId),
    () => ({ projectLookupRan: world.reads.slice(mark).some((read) => read.table === "projects") }),
  );
}

export async function milestoneLifecycle(
  world: WorldDb,
  verb: "delete" | "restore",
  standing: Standing,
  orgId: string,
  projectId: number,
  milestoneId: number,
): Promise<Observation> {
  const service = milestonesService(world);
  const actor = actorFor(standing, orgId);
  const mark = world.writes.length;
  return settle(
    () =>
      verb === "delete"
        ? service.deleteMilestone(actor, projectId, milestoneId)
        : service.restoreMilestone(actor, projectId, milestoneId),
    writeGate(world, mark, "project_milestones"),
  );
}

export async function ticketRead(
  world: WorldDb,
  standing: Standing,
  orgId: string,
  projectId: number,
  ticketId: number,
  variant?: Variant,
): Promise<Observation> {
  return settle(() =>
    assertTicketReadAccess(world.db, accessFor(world), actorFor(standing, orgId, variant), projectId, ticketId),
  );
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
      };
    },
  );
}
