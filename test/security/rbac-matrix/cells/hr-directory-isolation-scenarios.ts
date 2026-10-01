import type { Table } from "drizzle-orm";
import { documents, interviews } from "src/db/schema";
import { InterviewAvailabilityService } from "src/modules/hr/interviews/calendar/interview-availability.service";
import type { ProviderCredentialsService } from "src/modules/hr/recruitment/integrations/provider-credentials.service";
import { DocumentAccessService } from "src/modules/hr/performance/document-access.service";
import type { Observation, Scenario } from "../matrix.types";
import { ORG_A, accessFor, actorFor, membershipIdOf } from "../standings";
import { standIn, type Row } from "../world-db";
import { TENANT_ONLY, boundBy, freshWorld, markOf, pair, reached, victimOf } from "./isolation-kit";

const INTERVIEW_A = 7301;
const DOCUMENT_A = 7302;
const INTERVIEWER_A = membershipIdOf("module:member", ORG_A);
const SLOT_START = new Date("2026-10-05T10:00:00Z");
const SLOT_END = new Date("2026-10-05T11:00:00Z");

function isolationRows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [
      interviews,
      [{ id: INTERVIEW_A, orgId: ORG_A, interviewerMembershipId: INTERVIEWER_A, scheduledAt: SLOT_START, duration: 60, result: "PENDING" }],
    ],
    [documents, [{ id: DOCUMENT_A, orgId: ORG_A, isActive: true }]],
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

export function hrDirectoryIsolationScenarios(): Scenario[] {
  return [...interviewConflicts(), ...documentVisibility()];
}
