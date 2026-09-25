import type { ReportingRelationshipService } from "../../directory/reporting-relationship.service";
import type { MembershipMutations } from "../../../common/org/membership-mutations";
import type { MembershipAdmissionService } from "../../organization/core/membership-admission.service";
import type { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import type { ImportCommitContext } from "./hr-import-commit.service";

/**
 * Dependencies for suites that exercise the four import entities which resolve an
 * existing person — assets, documents, attendance, leave balances.
 *
 * They are wired to throw rather than to return a plausible value. A double that
 * answers happily would let a future change route one of those entities through
 * admission and still pass: the suite would be asserting against an invented
 * callee instead of the real one. Throwing means the only way these stay unused
 * is that the code really does not use them.
 *
 * The employees entity does use them, and is covered by a suite that supplies
 * the real services.
 */
function unreachable(what: string): never {
  throw new Error(
    `${what} was called by an import entity that should not admit anyone — ` +
      "wire the real service into this suite, or fix the commit path.",
  );
}

export function stubAdmission(): MembershipAdmissionService {
  return {
    admitOne: () => unreachable("MembershipAdmissionService.admitOne"),
    admitMany: () => unreachable("MembershipAdmissionService.admitMany"),
    screen: () => unreachable("MembershipAdmissionService.screen"),
    screenMany: () => unreachable("MembershipAdmissionService.screenMany"),
  } as unknown as MembershipAdmissionService;
}

export function stubPersonEmployment(): PersonEmploymentSyncService {
  return {
    ensureFromUser: () => unreachable("PersonEmploymentSyncService.ensureFromUser"),
    ensureManyFromUsers: () => unreachable("PersonEmploymentSyncService.ensureManyFromUsers"),
    ensureFromUserId: () => unreachable("PersonEmploymentSyncService.ensureFromUserId"),
  } as unknown as PersonEmploymentSyncService;
}

export function stubRelationships(): ReportingRelationshipService {
  return {
    setRelationships: () => unreachable("ReportingRelationshipService.setRelationships"),
  } as unknown as ReportingRelationshipService;
}

/** A commit context for a suite that drives one entity directly. */
export function importContext(orgId: string, actorId = "test-actor"): ImportCommitContext {
  return {
    orgId,
    actorId,
    actor: { orgId, system: "import-commit-test" },
    membership: {
      allocateMembershipId: () => unreachable("MembershipMutations.allocateMembershipId"),
    } as unknown as MembershipMutations,
  };
}
