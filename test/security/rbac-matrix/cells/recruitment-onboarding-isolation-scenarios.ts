import type { Table } from "drizzle-orm";
import { candidates, hrEmployments, hrPeople, organizationMembers, organizationPeople, organizations } from "src/db/schema";
import type { MembershipAdmissionService } from "src/modules/organization/core/membership-admission.service";
import type { OnboardingInitiationService } from "src/modules/hr/onboarding/core/onboarding-initiation.service";
import { RecruitmentOnboardingStartService } from "src/modules/hr/recruitment/recruitment-onboarding-start.service";
import type { Observation, Scenario } from "../matrix.types";
import { cache } from "../adapters/real-services";
import { outcomeOfError } from "../matrix-runner";
import { ORG_A, ORG_B } from "../standings";
import { standIn, worldDb, type Row } from "../world-db";
import { TENANT_ONLY, boundBy, markOf, pair, victimOf } from "./isolation-kit";

const HIRE_CANDIDATE_A = 7801;
const HIRE_PERSON_A = 7802;
const HIRE_EMPLOYMENT_A = 7803;
const OWNER_MEMBERSHIP: Readonly<Record<string, number>> = { [ORG_A]: 7811, [ORG_B]: 7812 };
const HIRE_EMAIL = "hire@example.com";
const HIRED_USER = `${ORG_A}:hired`;

function rows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [organizations, [ORG_A, ORG_B].map((id) => ({ id, ownerMembershipId: OWNER_MEMBERSHIP[id], status: "ACTIVE", deletedAt: null }))],
    [organizationMembers, [ORG_A, ORG_B].map((orgId) => ({ id: OWNER_MEMBERSHIP[orgId], orgId, userId: `${orgId}:owner` }))],
    [candidates, [{ id: HIRE_CANDIDATE_A, orgId: ORG_A, firstName: "Hira", lastName: "Joiner", email: HIRE_EMAIL, phone: null }]],
    [hrPeople, [{ id: HIRE_PERSON_A, orgId: ORG_A, organizationPersonId: "op-hire-a", deletedAt: null }]],
    [hrEmployments, [{ id: HIRE_EMPLOYMENT_A, orgId: ORG_A, personId: HIRE_PERSON_A, isPrimary: true, deletedAt: null, lifecycleStatus: "PRE_JOINING" }]],
    [organizationPeople, [{ organizationId: ORG_A, organizationPersonId: "op-hire-a", workEmail: HIRE_EMAIL, deletedAt: null }]],
  ]);
}

interface Started {
  readonly orgId: string;
  readonly userId: string;
}

async function startOnboarding(callerOrg: string): Promise<Observation> {
  const world = worldDb(rows(), { mutable: true });
  const screened: string[] = [];
  const initiated: Started[] = [];
  const admission = standIn<MembershipAdmissionService>({
    screen: async (_tx: unknown, input: { readonly orgId: string }) => {
      screened.push(input.orgId);
      return { kind: "conflict", reason: "already-member", userId: HIRED_USER };
    },
  });
  const onboarding = standIn<OnboardingInitiationService>({
    initiate: async (orgId: string, userId: string) => {
      initiated.push({ orgId, userId });
      return { tasksCreated: 2, fromTemplate: false };
    },
  });
  const service = new RecruitmentOnboardingStartService(world.db, cache, admission, onboarding);
  const mark = markOf(world);
  const checks = (): Record<string, boolean> => {
    const bound = boundBy(world, mark, "candidates");
    return {
      candidateLookupBindsCallerOrg: bound.includes(callerOrg) && bound.includes(HIRE_CANDIDATE_A),
      candidateLookupNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)),
      admissionOnlyInCallerOrg: screened.every((orgId) => orgId === callerOrg),
      onboardingOnlyInCallerOrg: initiated.every((call) => call.orgId === callerOrg),
    };
  };
  let outcome: unknown;
  try {
    outcome = await service.startForCandidate(callerOrg, HIRE_CANDIDATE_A);
  } catch (error: unknown) {
    return { outcome: outcomeOfError(error), checks: checks() };
  }
  const started = typeof outcome === "object" && outcome !== null && "started" in outcome && outcome.started === true;
  return {
    outcome: started && initiated.length === 1 ? "allow" : "404",
    checks: { ...checks(), nothingAdmittedUnlessStarted: started || (screened.length === 0 && initiated.length === 0) },
  };
}

export function onboardingStartScenarios(): Scenario[] {
  const entry = "RecruitmentOnboardingStartService.startForCandidate(orgId) <- the offer acceptance after-commit hook";
  return pair(
    { ...TENANT_ONLY, resource: "hr:hire-onboarding", action: "start" },
    "hr-hire-onboarding-start",
    {
      because: "the caller's own accepted candidate resolves, matches its pre-joining employment and has onboarding initiated in the caller's org",
      bindings: [{ adapter: "service", entry, run: () => startOnboarding(ORG_A) }],
    },
    {
      because: "the candidate lookup binds the requesting org, so another organisation's candidate id admits nobody and initiates no onboarding",
      bindings: [{ adapter: "service", entry, run: () => startOnboarding(ORG_B) }],
    },
  );
}
