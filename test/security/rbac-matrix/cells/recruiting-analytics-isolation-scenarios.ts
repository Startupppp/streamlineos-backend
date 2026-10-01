import type { Table } from "drizzle-orm";
import { candidateApplications, candidateOffers, candidates, interviews, jobPostings, users } from "src/db/schema";
import { RecruitingAnalyticsService, type RecruitingAnalytics } from "src/modules/hr/recruitment/analytics/recruiting-analytics.service";
import type { Observation, Scenario } from "../matrix.types";
import { ORG_A, ORG_B, membershipIdOf, userOf } from "../standings";
import type { Row } from "../world-db";
import { TENANT_ONLY, boundBy, markOf, pair, reached, standingWorld, victimOf } from "./isolation-kit";

const APPLICATION_A = 9401;
const CANDIDATE_A = 9402;
const JOB_A = 9403;
const WINDOW = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T00:00:00Z") };
const OPENED = new Date("2026-09-01T00:00:00Z");
const HIRED = new Date("2026-09-11T00:00:00Z");
const ANALYTICS_TABLES = ["candidate_applications", "interviews", "candidate_offers"];

function analyticsRows(): Map<Table, Row[]> {
  const interviewer = userOf("module:member", ORG_A);
  return new Map<Table, Row[]>([
    [
      candidateApplications,
      [{ id: APPLICATION_A, orgId: ORG_A, candidateId: CANDIDATE_A, jobPostingId: JOB_A, status: "ACCEPTED", appliedAt: OPENED, updatedAt: HIRED }],
    ],
    [jobPostings, [{ id: JOB_A, orgId: ORG_A, createdAt: OPENED }]],
    [candidates, [{ id: CANDIDATE_A, orgId: ORG_A, source: "REFERRAL" }]],
    [interviews, [{ id: 9404, orgId: ORG_A, interviewerMembershipId: membershipIdOf("module:member", ORG_A), result: "PASSED", scheduledAt: HIRED }]],
    [users, [{ id: interviewer, firstName: "Ivy", lastName: "Interviewer" }]],
    [candidateOffers, [{ id: 9405, orgId: ORG_A, offerStatus: "ACCEPTED", createdAt: HIRED }]],
  ]);
}

function nothingForeign(result: RecruitingAnalytics | undefined): boolean {
  if (result === undefined) return false;
  return (
    result.funnel.every((step) => step.count === 0) &&
    result.sources.length === 0 &&
    result.interviewerLoad.length === 0 &&
    result.offers.accepted + result.offers.declined + result.offers.outstanding === 0
  );
}

function windowRead(): Scenario[] {
  const run = (callerOrg: string) => async (): Promise<Observation> => {
    const world = standingWorld(analyticsRows());
    const service = new RecruitingAnalyticsService(world.db);
    const mark = markOf(world);
    let result: RecruitingAnalytics | undefined;
    return reached(
      async () => {
        result = await service.forWindow(callerOrg, WINDOW);
      },
      () => result?.empty === false,
      () => {
        const bound = ANALYTICS_TABLES.map((table) => boundBy(world, mark, table));
        return {
          everyAggregateBindsCallerOrg: bound.every((values) => values.includes(callerOrg)),
          noAggregateBindsVictimOrg: bound.every((values) => !values.includes(victimOf(callerOrg))),
          ownWindowCountsTheHire: callerOrg === ORG_B || (result?.funnel.find((step) => step.stage === "Hired")?.count === 1 && result.timeToFillDays.median === 10),
          noForeignCountLeaks: callerOrg === ORG_A || nothingForeign(result),
        };
      },
    );
  };
  const entry = "RecruitingAnalyticsService.forWindow(orgId) <- GET /hr/recruitment/analytics";
  return pair(
    { ...TENANT_ONLY, resource: "hr:recruiting-analytics", action: "read" },
    "hr-recruiting-analytics-window",
    {
      because: "the caller's own window aggregates its hire, its source, its interviewer's load and its accepted offer",
      bindings: [{ adapter: "service", entry, run: run(ORG_A) }],
    },
    {
      because: "every aggregate binds the requesting org, so another organisation's window over the same dates counts none of the first organisation's applications, interviews or offers",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

export function recruitingAnalyticsIsolationScenarios(): Scenario[] {
  return windowRead();
}
