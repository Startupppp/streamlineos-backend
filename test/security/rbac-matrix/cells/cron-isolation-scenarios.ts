import type { Table } from "drizzle-orm";
import { candidateSlaTracking, interviewSlas, organizations, scheduledReports } from "src/db/schema";
import { CronRecruitmentReportsService } from "src/modules/cron/cron-recruitment-reports.service";
import { CronRecruitmentSlaService } from "src/modules/cron/cron-recruitment-sla.service";
import type { EmailService } from "src/modules/email/email.service";
import type { HrRecruitmentReportsService } from "src/modules/hr/interviews/hr-recruitment-reports.service";
import type { Observation, Scenario } from "../matrix.types";
import { ORG_A, ORG_B, standingRows } from "../standings";
import { mergeRows, standIn, worldDb, type Row, type WorldDb } from "../world-db";
import { TENANT_ONLY, boundBy, markOf, pair, reached, standingWorld } from "./isolation-kit";

const TRACKED_STAGE = "SCREENING";
const TRACKING_ROW = 9201;
const SCHEDULE_ROW = 9301;
const SCHEDULE_NAME = "Weekly pipeline";
const LONG_AGO = new Date("2026-01-01T00:00:00Z");

function rowOf(world: WorldDb, table: Table, id: number): Row | undefined {
  return (world.rows.get(table) ?? []).find((row) => row.id === id);
}

function sweepPair(
  resource: string,
  action: string,
  id: string,
  entry: string,
  run: (foreign: boolean) => () => Promise<Observation>,
  because: { readonly allow: string; readonly deny: string },
): Scenario[] {
  return pair(
    { ...TENANT_ONLY, resource, action },
    id,
    { because: because.allow, bindings: [{ adapter: "job", entry, run: run(false) }] },
    { because: because.deny, bindings: [{ adapter: "job", entry, run: run(true) }] },
  );
}

function slaSweep(): Scenario[] {
  const run = (foreign: boolean) => async (): Promise<Observation> => {
    const owner = foreign ? ORG_B : ORG_A;
    const world = standingWorld(
      new Map<Table, Row[]>([
        [interviewSlas, [{ id: 9101, orgId: ORG_A, stage: TRACKED_STAGE, maxHours: 48, warningHours: 24 }]],
        [candidateSlaTracking, [{ id: TRACKING_ROW, orgId: owner, candidateId: 9102, stage: TRACKED_STAGE, status: "ON_TRACK", enteredAt: LONG_AGO }]],
      ]),
    );
    const service = new CronRecruitmentSlaService(world.db);
    const mark = markOf(world);
    let breached = -1;
    return reached(
      async () => {
        breached = (await service.sweepStageSlas()).breached;
      },
      () => rowOf(world, candidateSlaTracking, TRACKING_ROW)?.status === "BREACHED",
      () => {
        const bound = boundBy(world, mark, "candidate_sla_tracking");
        return {
          clockUpdatesBindTheConfiguredOrg: bound.includes(ORG_A),
          clockUpdatesNeverBindTheOtherOrg: !bound.includes(ORG_B),
          breachCountMatchesTheOwnRowOnly: breached === (foreign ? 0 : 1),
          foreignClockUntouched: !foreign || rowOf(world, candidateSlaTracking, TRACKING_ROW)?.status === "ON_TRACK",
        };
      },
    );
  };
  return sweepPair(
    "hr:candidate-stage-sla",
    "breach",
    "hr-candidate-stage-sla-breach",
    "CronRecruitmentSlaService.sweepStageSlas() <- recruitment-sla-sweep cron",
    run,
    {
      allow: "an organisation's own stage threshold breaches its own candidate whose clock started long before the limit",
      deny: "another organisation's candidate in the same stage is outside the first organisation's threshold update, and its own organisation configures no threshold, so its clock stays on track",
    },
  );
}

function reportsWorld(owner: string): WorldDb {
  const other = standingRows(ORG_B);
  other.delete(organizations);
  return worldDb(
    mergeRows(
      standingRows(ORG_A),
      other,
      new Map<Table, Row[]>([
        [
          scheduledReports,
          [
            {
              id: SCHEDULE_ROW,
              orgId: owner,
              name: SCHEDULE_NAME,
              reportConfig: { entity: "candidates", fields: ["id"], filters: {} },
              schedule: "WEEKLY",
              recipients: ["recruiting@example.com"],
              lastRunAt: LONG_AGO,
            },
          ],
        ],
      ]),
    ),
    { mutable: true },
  );
}

function reportsSweep(): Scenario[] {
  const run = (foreign: boolean) => async (): Promise<Observation> => {
    const world = reportsWorld(foreign ? ORG_B : ORG_A);
    const rendered: string[] = [];
    const sent: string[] = [];
    const service = new CronRecruitmentReportsService(
      world.db,
      standIn<EmailService>({
        sendEmail: async (input: { readonly subject: string }) => {
          sent.push(input.subject);
        },
      }),
      standIn<HrRecruitmentReportsService>({
        generateReport: async (orgId: string) => {
          rendered.push(orgId);
          return { rows: [], total: 0 };
        },
      }),
    );
    const mark = markOf(world);
    return reached(
      () => service.deliverDueReports(),
      () => sent.some((subject) => subject.startsWith(SCHEDULE_NAME)),
      () => {
        const bound = boundBy(world, mark, "scheduled_reports");
        return {
          dueQueryBindsTheSweptOrg: bound.includes(ORG_A),
          dueQueryNeverBindsTheUnsweptOrg: !bound.includes(ORG_B),
          reportRenderedOnlyForTheSweptOrg: rendered.every((orgId) => orgId === ORG_A),
          foreignScheduleNotStamped: !foreign || rowOf(world, scheduledReports, SCHEDULE_ROW)?.lastRunAt === LONG_AGO,
        };
      },
    );
  };
  return sweepPair(
    "hr:scheduled-report",
    "deliver",
    "hr-scheduled-report-deliver",
    "CronRecruitmentReportsService.deliverDueReports() <- recruitment-scheduled-reports cron",
    run,
    {
      allow: "a weekly schedule last run long ago in the swept organisation is rendered, mailed and stamped",
      deny: "a due schedule belonging to an organisation the sweep is not visiting is never selected by the swept organisation's due query, so it is neither rendered, mailed nor stamped",
    },
  );
}

export function cronIsolationScenarios(): Scenario[] {
  return [...slaSweep(), ...reportsSweep()];
}
