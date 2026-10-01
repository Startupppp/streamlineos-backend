import type { Table } from "drizzle-orm";
import { employeeSalaryProfiles, hrEmployments, hrPeople, organizationPeople, workers } from "src/db/schema";
import { PayeeEligibilityController } from "src/modules/payroll/runs/payee-eligibility.controller";
import { PayeeEligibilityService } from "src/modules/payroll/runs/payee-eligibility.service";
import { ProfilesService } from "src/modules/payroll/runs/profiles.service";
import { SalaryProfilesRepository } from "src/modules/payroll/runs/salary-profiles.repository";
import type { AuditService } from "src/common/audit/audit.service";
import type { ExpectedOutcome, Observation, Scenario } from "../matrix.types";
import { sendHttp } from "../adapters/http-adapter";
import { tenantBound } from "../adapters/hr-adapter";
import { ORG_A, ORG_B, membershipIdOf, userOf, type Standing } from "../standings";
import { boundValues, standIn, type Row, type WorldDb } from "../world-db";

export const PAYABLE_PERSON_A = "person-a-payable";
export const UNPAID_PERSON_A = "person-a-unpaid";
export const EMPLOYED_PERSON_A = "person-a-employed";
export const WORKER_A = "worker-a";
const DELETED = null;

function person(organizationPersonId: string, userId: string | null, membershipId: number | null): Row {
  return { organizationId: ORG_A, organizationPersonId, userId, organizationMembershipId: membershipId, deletedAt: DELETED };
}

export function payrollRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [
      organizationPeople,
      [
        person(PAYABLE_PERSON_A, userOf("org:member", ORG_A), membershipIdOf("org:member", ORG_A)),
        person(UNPAID_PERSON_A, null, null),
        person(EMPLOYED_PERSON_A, null, null),
      ],
    ],
    [
      workers,
      [{ workerId: WORKER_A, organizationId: ORG_A, organizationPersonId: "person-a-worker", userId: null, isPayee: true, deletedAt: DELETED }],
    ],
    [hrPeople, [{ id: 61, orgId: ORG_A, organizationPersonId: EMPLOYED_PERSON_A, deletedAt: DELETED }]],
    [hrEmployments, [{ id: 62, orgId: ORG_A, personId: 61, employeeNumber: "E-62", lifecycleStatus: "ACTIVE" }]],
    [
      employeeSalaryProfiles,
      [
        {
          id: 63,
          orgId: ORG_A,
          userId: null,
          workerId: WORKER_A,
          workerType: "CONTRACTOR",
          currency: "INR",
          payoutCurrency: "INR",
          annualCtc: 100,
          taxRegime: null,
          costCenter: null,
          status: "ACTIVE",
          effectiveFrom: "2026-04-01",
        },
      ],
    ],
  ]);
}

const ELIGIBILITY_ENTRY = "GET /payroll/people/:organizationPersonId/eligibility -> PayeeEligibilityService";

function reasonOf(body: unknown): unknown {
  return body !== null && typeof body === "object" && "reason" in body ? body.reason : undefined;
}

async function eligibility(world: WorldDb, standing: Standing, orgId: string, personId: string, reason: string | null): Promise<Observation> {
  const exchange = await sendHttp(world, {
    controllers: [PayeeEligibilityController],
    services: [{ provide: PayeeEligibilityService, useValue: new PayeeEligibilityService(world.db) }],
    verb: "get",
    path: `/payroll/people/${personId}/eligibility`,
    permissionKey: "payroll:salaries:view",
    standing,
    orgId,
  });
  const lookups = world.reads.slice(exchange.readMark).filter((read) => read.table === "organization_people");
  const bound = lookups.flatMap((read) => boundValues(read.where));
  const checks: Record<string, boolean> = {
    routeAskedForItsKey: exchange.asked.includes("payroll:salaries:view"),
    refusalCarriesNoEligibilityBody: exchange.outcome === "allow" || !JSON.stringify(exchange.body).includes("unknown-person"),
  };
  if (exchange.guardPassed) {
    checks.personResolvedUnderCallerOrgOnly = lookups.length === 1 && bound.includes(orgId) && bound.includes(personId) && (orgId === ORG_A || !bound.includes(ORG_A));
  }
  if (reason !== null) checks.answersTheDomainReason = exchange.outcome !== "allow" || reasonOf(exchange.body) === reason;
  return { outcome: exchange.outcome, checks };
}

function eligibilityScenarios(world: WorldDb): Scenario[] {
  const cases: ReadonlyArray<{ readonly suffix: string; readonly standing: Standing; readonly orgId: string; readonly person: string; readonly reason: string | null; readonly expected: ExpectedOutcome; readonly because: string; readonly pairedWith?: string }> = [
    { suffix: "payable", standing: "org:admin", orgId: ORG_A, person: PAYABLE_PERSON_A, reason: "payable", expected: "allow", because: "a person the caller's org holds with a membership is answered payable" },
    { suffix: "not-payable", standing: "org:admin", orgId: ORG_A, person: UNPAID_PERSON_A, reason: "not-payable", expected: "allow", because: "a held person with no membership, worker or employment is answered not-payable rather than refused" },
    { suffix: "employed-not-payable", standing: "org:admin", orgId: ORG_A, person: EMPLOYED_PERSON_A, reason: "employed-but-not-payable", expected: "allow", because: "a held person with only an employment is answered employed-but-not-payable" },
    { suffix: "org-owner", standing: "org:owner", orgId: ORG_A, person: PAYABLE_PERSON_A, reason: "payable", expected: "allow", because: "the owner holds payroll:salaries:view" },
    { suffix: "cross-tenant", standing: "org:admin", orgId: ORG_B, person: PAYABLE_PERSON_A, reason: null, expected: "404", because: "another organisation's person resolves unknown under the caller's org and the boundary answers 404, never 403 or a soft 200", pairedWith: "payroll-payee-eligibility-payable" },
    { suffix: "owner-cross-tenant", standing: "org:owner", orgId: ORG_B, person: PAYABLE_PERSON_A, reason: null, expected: "404", because: "owner standing in one organisation resolves no person of another", pairedWith: "payroll-payee-eligibility-org-owner" },
    { suffix: "org-member", standing: "org:member", orgId: ORG_A, person: PAYABLE_PERSON_A, reason: null, expected: "403", because: "a plain member never holds payroll:salaries:view, so the guard refuses before any person is resolved", pairedWith: "payroll-payee-eligibility-payable" },
  ];
  return cases.map((item): Scenario => ({
    id: `payroll-payee-eligibility-${item.suffix}`,
    actor: item.standing,
    resource: "payroll:payee-eligibility",
    action: "read",
    tenant: item.orgId === ORG_A ? "same" : "other",
    state: "normal",
    expected: item.expected,
    because: item.because,
    pairedWith: item.pairedWith,
    bindings: [{ adapter: "http", entry: ELIGIBILITY_ENTRY, run: () => eligibility(world, item.standing, item.orgId, item.person, item.reason) }],
  }));
}

function workerHistoryScenarios(world: WorldDb): Scenario[] {
  const service = new ProfilesService(world.db, standIn<AuditService>({}), new SalaryProfilesRepository(world.db));
  const entry = "ProfilesService.listHistoryByWorker(orgId) <- GET /payroll/workers/:workerId/history";
  const run = (callerOrg: string) => () =>
    tenantBound(
      world,
      { callerOrg, victimOrg: callerOrg === ORG_A ? ORG_B : ORG_A, ids: [WORKER_A] },
      () => service.listHistoryByWorker(callerOrg, WORKER_A),
      { lookup: "workers", followUp: "employee_salary_profiles" },
      (value) => ({ historyIsTheWorkersOwn: value === undefined || (Array.isArray(value) && value.length === 1) }),
    );
  return [
    {
      id: "payroll-worker-history-same-tenant",
      actor: "tenant-only",
      resource: "payroll:worker-history",
      action: "list",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "a worker the caller's org holds is resolved and its salary history is read once",
      bindings: [{ adapter: "service", entry, run: run(ORG_A) }],
    },
    {
      id: "payroll-worker-history-cross-tenant",
      actor: "tenant-only",
      resource: "payroll:worker-history",
      action: "list",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "another organisation's worker is not held by the caller's org, so the answer is 404 and the salary history is never queried",
      pairedWith: "payroll-worker-history-same-tenant",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  ];
}

export function payrollScenarios(world: WorldDb): Scenario[] {
  return [...eligibilityScenarios(world), ...workerHistoryScenarios(world)];
}
