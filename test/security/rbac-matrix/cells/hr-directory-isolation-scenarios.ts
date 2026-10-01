import type { Table } from "drizzle-orm";
import { documents, hrEmployments, hrPeople, hrReportingManagerRequests, interviews } from "src/db/schema";
import type { AuditService } from "src/common/audit/audit.service";
import { InterviewAvailabilityService } from "src/modules/hr/interviews/calendar/interview-availability.service";
import type { ProviderCredentialsService } from "src/modules/hr/recruitment/integrations/provider-credentials.service";
import { DocumentAccessService } from "src/modules/hr/performance/document-access.service";
import { ReportingManagerRequestsService } from "src/modules/hr/directory/reporting-manager-requests.service";
import { listMyReportingManagerRequestsSchema } from "src/modules/hr/directory/dto/reporting-lines-requests.schemas";
import type { NotificationDispatchService } from "src/modules/notifications/notification-dispatch.service";
import type { ReportingLineService } from "src/modules/directory/reporting-line.service";
import type { ReportingRelationshipService } from "src/modules/directory/reporting-relationship.service";
import type { Observation, Scenario } from "../matrix.types";
import { ORG_A, accessFor, actorFor, membershipIdOf } from "../standings";
import { standIn, type Row } from "../world-db";
import { TENANT_ONLY, boundBy, freshWorld, markOf, pair, reached, victimOf } from "./isolation-kit";

const INTERVIEW_A = 7301;
const DOCUMENT_A = 7302;
const INTERVIEWER_A = membershipIdOf("module:member", ORG_A);
const REQUEST_A = "7a000000-0000-4000-8000-000000007303";
const EMPLOYMENT_A = 7304;
const PERSON_A = 7305;
const PERSON_IN_TWO_ORGS = "person-in-two-orgs";
const FILED_AT = new Date("2026-09-15T09:30:00.123Z");
const SLOT_START = new Date("2026-10-05T10:00:00Z");
const SLOT_END = new Date("2026-10-05T11:00:00Z");

function isolationRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [
      interviews,
      [{ id: INTERVIEW_A, orgId: ORG_A, interviewerMembershipId: INTERVIEWER_A, scheduledAt: SLOT_START, duration: 60, result: "PENDING" }],
    ],
    [documents, [{ id: DOCUMENT_A, orgId: ORG_A, isActive: true }]],
    [
      hrReportingManagerRequests,
      [
        {
          id: REQUEST_A,
          orgId: ORG_A,
          employeeEmploymentId: EMPLOYMENT_A,
          requestedByUserId: PERSON_IN_TWO_ORGS,
          currentPrimaryLineId: null,
          suggestedManagerEmploymentId: null,
          requestedEffectiveFrom: null,
          employeeReason: "My manager changed teams",
          status: "PENDING",
          reviewerUserId: null,
          reviewReason: null,
          createdAt: FILED_AT,
          updatedAt: FILED_AT,
          resolvedAt: null,
          deletedAt: null,
        },
      ],
    ],
    [hrEmployments, [{ id: EMPLOYMENT_A, orgId: ORG_A, personId: PERSON_A, deletedAt: null }]],
    [hrPeople, [{ id: PERSON_A, orgId: ORG_A, userId: PERSON_IN_TWO_ORGS, deletedAt: null }]],
  ]);
}

function interviewConflicts(): Scenario[] {
  const run = (callerOrg: string) => async (): Promise<Observation> => {
    const world = freshWorld(isolationRows());
    const service = new InterviewAvailabilityService(world.db, standIn<ProviderCredentialsService>({}));
    const mark = markOf(world);
    let found: ReadonlyArray<{ readonly interviewId: number }> = [];
    return reached(
      async () => {
        found = await service.conflictsFor(callerOrg, [INTERVIEWER_A], { start: SLOT_START, end: SLOT_END });
      },
      () => found.some((conflict) => conflict.interviewId === INTERVIEW_A),
      () => {
        const bound = boundBy(world, mark, "interviews");
        return {
          busyReadBindsCallerOrg: bound.includes(callerOrg),
          busyReadNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)),
          noForeignConflictReturned: callerOrg === ORG_A || found.length === 0,
        };
      },
    );
  };
  const entry = "InterviewAvailabilityService.conflictsFor(orgId) <- interview scheduling panel conflict check";
  return pair(
    { ...TENANT_ONLY, resource: "hr:interview-availability", action: "conflicts" },
    "hr-interview-conflicts",
    {
      because: "a pending interview the caller's organisation holds for the panel member overlaps the slot and is reported as a conflict",
      bindings: [{ adapter: "service", entry, run: run(ORG_A) }],
    },
    {
      because: "the busy query binds the caller's org, so another organisation's interview on the same membership id is never seen and no conflict leaks its schedule",
      bindings: [{ adapter: "service", entry, run: run(victimOf(ORG_A)) }],
    },
  );
}

function documentVisibility(): Scenario[] {
  const run = (callerOrg: string) => async (): Promise<Observation> => {
    const world = freshWorld(isolationRows());
    const service = new DocumentAccessService(world.db, accessFor(world));
    const mark = markOf(world);
    let visible = false;
    return reached(
      async () => {
        const principal = await service.principalFor(actorFor("org:owner", callerOrg));
        visible = await service.canViewDocument(principal, DOCUMENT_A);
      },
      () => visible,
      () => {
        const bound = boundBy(world, mark, "documents");
        return {
          documentReadBindsCallerOrgAndId: bound.includes(callerOrg) && bound.includes(DOCUMENT_A),
          documentReadNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)),
        };
      },
    );
  };
  const entry = "DocumentAccessService.canViewDocument(principal) <- assertCanAct on /hr/documents/:documentId";
  return pair(
    { actor: "org:owner", state: "normal", resource: "hr:document", action: "view" },
    "hr-document-visibility",
    {
      because: "the owner's unrestricted documents scope still reads its own organisation's active document and finds it",
      bindings: [{ adapter: "service", entry, run: run(ORG_A) }],
    },
    {
      because: "owner standing in another organisation reads under its own tenant, so the foreign document id is not viewable and the caller answers 404",
      bindings: [{ adapter: "service", entry, run: run(victimOf(ORG_A)) }],
    },
  );
}

function managerRequests(): Scenario[] {
  const query = listMyReportingManagerRequestsSchema.parse({});
  const run = (callerOrg: string) => async (): Promise<Observation> => {
    const world = freshWorld(isolationRows());
    const service = new ReportingManagerRequestsService(
      world.db,
      accessFor(world),
      standIn<AuditService>({}),
      standIn<NotificationDispatchService>({}),
      standIn<ReportingLineService>({}),
      standIn<ReportingRelationshipService>({}),
    );
    const mark = markOf(world);
    let listed: ReadonlyArray<{ readonly requestId: string }> = [];
    return reached(
      async () => {
        listed = (await service.listMine({ ...actorFor("org:member", callerOrg), userId: PERSON_IN_TWO_ORGS }, query)).items;
      },
      () => listed.some((request) => request.requestId === REQUEST_A),
      () => {
        const bound = boundBy(world, mark, "hr_reporting_manager_requests");
        return {
          requestReadBindsCallerOrg: bound.includes(callerOrg) && bound.includes(PERSON_IN_TWO_ORGS),
          requestReadNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)),
          noForeignRequestListed: callerOrg === ORG_A || listed.length === 0,
        };
      },
    );
  };
  const entry = "ReportingManagerRequestsService.listMine(actor) <- GET /me/reporting-manager-requests";
  return pair(
    { actor: "org:member", state: "normal", resource: "hr:reporting-manager-request", action: "list-mine" },
    "hr-reporting-manager-request-list-mine",
    {
      because: "a person lists the reporting-manager change they filed in their own organisation",
      bindings: [{ adapter: "service", entry, run: run(ORG_A) }],
    },
    {
      because: "the same person acting in another organisation lists under that organisation only, so the request filed in the first organisation never appears",
      bindings: [{ adapter: "service", entry, run: run(victimOf(ORG_A)) }],
    },
  );
}

export function hrDirectoryIsolationScenarios(): Scenario[] {
  return [...interviewConflicts(), ...documentVisibility(), ...managerRequests()];
}
