import type { Table } from "drizzle-orm";
import {
  auditLogs,
  candidateApplications,
  candidateDocumentsVault,
  candidateSlaTracking,
  candidates,
  hrWebhookDeliveries,
  hrWebhookSubscriptions,
  interviews,
  jobBoardPostings,
  jobPostings,
} from "src/db/schema";
import type { Db } from "src/db/drizzle.types";
import { AssessmentService } from "src/modules/hr/recruitment/assessments/assessment.service";
import { BgvService } from "src/modules/hr/recruitment/bgv/bgv.service";
import { ChatNotifyService } from "src/modules/hr/recruitment/chat-notify/chat-notify.service";
import { CandidateErasureService } from "src/modules/hr/recruitment/consent/candidate-erasure.service";
import { AtsSandboxService } from "src/modules/hr/recruitment/developer/ats-sandbox.service";
import { JobBoardPublisherService } from "src/modules/hr/recruitment/boards/job-board-publisher.service";
import { RecruitmentJobsService } from "src/modules/hr/recruitment/recruitment-jobs.service";
import { publishJobSchema } from "src/modules/hr/recruitment/dto/jobs.schemas";
import type { ProviderCredentialsService } from "src/modules/hr/recruitment/integrations/provider-credentials.service";
import type { ProviderCredentials } from "src/modules/hr/recruitment/integrations/provider-blocked";
import type { Observation, Scenario } from "../matrix.types";
import { audit, cache } from "../adapters/real-services";
import { tenantBound } from "../adapters/hr-adapter";
import { ORG_A } from "../standings";
import { standIn, type Row, type WorldDb } from "../world-db";
import { TENANT_ONLY, boundBy, markOf, pair, reached, standingWorld, victimOf } from "./isolation-kit";

export const CANDIDATE_A = 7101;
export const CANDIDATE_B = 7201;
const JOB_A = 7301;
const SUBSCRIPTION_A = 7401;
const DELIVERY_A = 7501;
const INTERVIEW_A = 7601;
const CREATED = new Date("2026-08-01T00:00:00Z");
const EVENT = "candidate.applied";

export function candidateRow(id: number, orgId: string, overrides: Readonly<Record<string, unknown>> = {}): Row {
  return {
    id,
    orgId,
    firstName: "Asha",
    lastName: "Rao",
    email: `candidate-${id}@example.com`,
    phone: null,
    externalId: null,
    bgvStatus: "NOT_INITIATED",
    bgvSource: null,
    bgvAgency: null,
    bgvReference: null,
    bgvNotes: null,
    bgvInitiatedAt: null,
    bgvCompletedAt: null,
    ...overrides,
  };
}

export function credentialsWith(secrets: Readonly<Record<string, string>>): ProviderCredentialsService {
  return standIn<ProviderCredentialsService>({
    forPlatform: async (orgId: string, platform: string): Promise<ProviderCredentials | null> => {
      const secret = secrets[orgId];
      return secret === undefined ? null : { platform, isActive: true, token: null, meta: { inboundSecret: secret } };
    },
  });
}

const NO_CREDENTIALS = credentialsWith({});

function recruitingWorld(): WorldDb {
  return standingWorld(
    new Map<Table, Row[]>([
      [candidates, [candidateRow(CANDIDATE_A, ORG_A)]],
      [
        interviews,
        [
          {
            id: INTERVIEW_A,
            orgId: ORG_A,
            candidateId: CANDIDATE_A,
            type: "ASSESSMENT",
            externalRef: "ref-a",
            meetingLink: "https://tests.invalid/a",
            notes: "test-a",
            result: "PENDING",
            rating: null,
            scheduledAt: CREATED,
            updatedAt: CREATED,
          },
        ],
      ],
      [candidateApplications, [{ id: 7701, orgId: ORG_A, candidateId: CANDIDATE_A }]],
      [candidateSlaTracking, [{ id: 7702, orgId: ORG_A, candidateId: CANDIDATE_A }]],
      [candidateDocumentsVault, []],
      [auditLogs, []],
      [jobPostings, [{ id: JOB_A, orgId: ORG_A, status: "OPEN", title: "Engineer" }]],
      [jobBoardPostings, []],
      [
        hrWebhookSubscriptions,
        [{ id: SUBSCRIPTION_A, orgId: ORG_A, name: "ATS", secret: "whsec_a", events: [], isActive: true, deletedAt: null }],
      ],
      [
        hrWebhookDeliveries,
        [
          {
            id: DELIVERY_A,
            orgId: ORG_A,
            subscriptionId: SUBSCRIPTION_A,
            event: EVENT,
            payload: { candidateId: CANDIDATE_A },
            status: "delivered",
            attempts: 1,
            responseStatus: 200,
            error: null,
            createdAt: CREATED,
            lastAttemptAt: null,
          },
        ],
      ],
    ]),
  );
}

function probe(callerOrg: string, ids: readonly unknown[]): { callerOrg: string; victimOrg: string; ids: readonly unknown[] } {
  return { callerOrg, victimOrg: victimOf(callerOrg), ids };
}

function stillHolds(world: WorldDb, table: Table, id: number): boolean {
  return (world.rows.get(table) ?? []).some((row) => row.id === id && row.orgId === ORG_A);
}

function assessments(): Scenario[] {
  const run = (callerOrg: string) => (): Promise<Observation> => {
    const world = recruitingWorld();
    const service = new AssessmentService(world.db, audit, NO_CREDENTIALS);
    const mark = markOf(world);
    let rows: ReadonlyArray<{ readonly id: number; readonly candidateId: number }> = [];
    return reached(
      async () => {
        rows = await service.listForCandidate(callerOrg, CANDIDATE_A);
      },
      () => rows.some((row) => row.id === INTERVIEW_A),
      () => {
        const bound = boundBy(world, mark, "interviews");
        return { listBindsCallerOrgAndCandidate: bound.includes(callerOrg) && bound.includes(CANDIDATE_A), listNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)) };
      },
    );
  };
  const entry = "AssessmentService.listForCandidate(orgId) <- GET /hr/recruitment/candidates/:candidateId/assessments";
  return pair(
    { ...TENANT_ONLY, resource: "hr:assessment", action: "list" },
    "hr-assessment-list",
    { because: "the caller's own candidate's assessment invitation is listed with its vendor reference", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the list binds the requesting org, so another organisation's candidate id lists no assessment, reference or candidate link",
      bindings: [{ adapter: "service", entry, run: run(victimOf(ORG_A)) }],
    },
  );
}

function bgv(): Scenario[] {
  const run = (callerOrg: string) => (): Promise<Observation> => {
    const world = recruitingWorld();
    const service = new BgvService(world.db, audit, NO_CREDENTIALS);
    return tenantBound(world, probe(callerOrg, [CANDIDATE_A]), () => service.read(callerOrg, CANDIDATE_A), { lookup: "candidates", sites: 1 }, (value) => ({
      returnsOnlyTheCallersCandidate: value === undefined || (typeof value === "object" && value !== null && "candidateId" in value && value.candidateId === CANDIDATE_A),
    }));
  };
  const entry = "BgvService.read(orgId) <- GET /hr/recruitment/candidates/:candidateId/bgv";
  return pair(
    { ...TENANT_ONLY, resource: "hr:candidate-bgv", action: "read" },
    "hr-candidate-bgv-read",
    { because: "the caller's own candidate resolves and its verification state is read", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the candidate lookup binds the caller's org, so another organisation's candidate answers 404 before any agency reference is read",
      bindings: [{ adapter: "service", entry, run: run(victimOf(ORG_A)) }],
    },
  );
}

function chatNotify(): Scenario[] {
  const run = (callerOrg: string) => (): Promise<Observation> => {
    const world = recruitingWorld();
    const found: unknown[] = [];
    const candidatesQuery = world.db.query.candidates;
    const spying = standIn<Db>({
      ...world.db,
      query: {
        ...world.db.query,
        candidates: {
          findFirst: async (options: Parameters<typeof candidatesQuery.findFirst>[0]) => {
            const row = await candidatesQuery.findFirst(options);
            found.push(row);
            return row;
          },
        },
      },
    });
    const service = new ChatNotifyService(spying, NO_CREDENTIALS);
    const mark = markOf(world);
    return reached(
      () =>
        service.notifyInterview(callerOrg, {
          interviewId: INTERVIEW_A,
          candidateId: CANDIDATE_A,
          jobPostingId: JOB_A,
          scheduledAt: CREATED,
          durationMinutes: 30,
          kind: "assigned",
        }),
      () => found.some((row) => row !== undefined),
      () => {
        const candidateBound = boundBy(world, mark, "candidates");
        const jobBound = boundBy(world, mark, "job_postings");
        return {
          candidateLookupBindsCallerOrg: candidateBound.includes(callerOrg) && candidateBound.includes(CANDIDATE_A),
          jobLookupBindsCallerOrg: jobBound.includes(callerOrg) && jobBound.includes(JOB_A),
          neverBindsVictimOrg: ![...candidateBound, ...jobBound].includes(victimOf(callerOrg)),
        };
      },
    );
  };
  const entry = "ChatNotifyService.notifyInterview(orgId)";
  return pair(
    { ...TENANT_ONLY, resource: "hr:interview-chat-notice", action: "notify" },
    "hr-interview-chat-notice",
    { because: "the caller's own candidate's first name is resolved for the interview notice", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the candidate and job lookups bind the notifying org, so another organisation's candidate name and job title never reach a chat notice",
      bindings: [{ adapter: "service", entry, run: run(victimOf(ORG_A)) }],
    },
  );
}

function erasure(): Scenario[] {
  const run = (callerOrg: string) => (): Promise<Observation> => {
    const world = recruitingWorld();
    const service = new CandidateErasureService(world.db, standIn({}));
    return tenantBound(
      world,
      probe(callerOrg, [CANDIDATE_A]),
      () => service.eraseCandidate(callerOrg, CANDIDATE_A, `${callerOrg}:dpo`),
      { lookup: "candidates", writes: { table: "candidates", verb: "delete" } },
      (value) => ({
        foreignCandidateSurvives: value !== undefined || stillHolds(world, candidates, CANDIDATE_A),
        foreignInterviewsSurvive: value !== undefined || stillHolds(world, interviews, INTERVIEW_A),
        noErasureAuditedForTheCaller: value !== undefined || !world.writes.some((write) => write.table === "audit_logs"),
      }),
    );
  };
  const entry = "CandidateErasureService.eraseCandidate(orgId) <- DELETE /hr/recruitment/candidates/:candidateId/personal-data";
  return pair(
    { ...TENANT_ONLY, resource: "hr:candidate", action: "erase" },
    "hr-candidate-erase",
    { because: "the caller's own candidate is found under its org and every dependent record is deleted", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "another organisation's candidate is not found under the caller's org, so the irreversible erasure answers 404 and deletes nothing",
      bindings: [{ adapter: "service", entry, run: run(victimOf(ORG_A)) }],
    },
  );
}

function sandbox(): Scenario[] {
  const signature = (callerOrg: string) => (): Promise<Observation> => {
    const world = recruitingWorld();
    const service = new AtsSandboxService(world.db, audit);
    return tenantBound(world, probe(callerOrg, [SUBSCRIPTION_A, DELIVERY_A]), () => service.signatureFor(callerOrg, SUBSCRIPTION_A, DELIVERY_A), {
      lookup: "hr_webhook_deliveries",
      sites: 1,
    });
  };
  const replay = (callerOrg: string) => (): Promise<Observation> => {
    const world = recruitingWorld();
    const service = new AtsSandboxService(world.db, audit);
    return tenantBound(
      world,
      probe(callerOrg, [SUBSCRIPTION_A]),
      () => service.replay(callerOrg, `${callerOrg}:developer`, SUBSCRIPTION_A, EVENT),
      { lookup: "hr_webhook_subscriptions", writes: { table: "hr_webhook_deliveries", verb: "insert" } },
    );
  };
  const signatureEntry = "AtsSandboxService.signatureFor(orgId) <- GET /hr/recruitment/developer/subscriptions/:subscriptionId/deliveries/:deliveryId/signature";
  const replayEntry = "AtsSandboxService.replay(orgId) <- POST /hr/recruitment/developer/subscriptions/:subscriptionId/replay";
  return [
    ...pair(
      { ...TENANT_ONLY, resource: "hr:ats-webhook-delivery", action: "sign" },
      "hr-ats-delivery-signature",
      { because: "the caller's own delivery joins its own subscription and is re-signed with that subscription's secret", bindings: [{ adapter: "service", entry: signatureEntry, run: signature(ORG_A) }] },
      {
        because: "the delivery lookup binds the caller's org on both sides of the join, so another organisation's delivery answers 404 and its secret never signs anything",
        bindings: [{ adapter: "service", entry: signatureEntry, run: signature(victimOf(ORG_A)) }],
      },
    ),
    ...pair(
      { ...TENANT_ONLY, resource: "hr:ats-webhook-subscription", action: "replay" },
      "hr-ats-subscription-replay",
      { because: "the caller's own active subscription resolves and one replay delivery is queued under the caller's org", bindings: [{ adapter: "service", entry: replayEntry, run: replay(ORG_A) }] },
      {
        because: "another organisation's subscription is not found under the caller's org, so the answer is 404 and no delivery is queued to its endpoint",
        bindings: [{ adapter: "service", entry: replayEntry, run: replay(victimOf(ORG_A)) }],
      },
    ),
  ];
}

function boardPublishing(): Scenario[] {
  const body = publishJobSchema.parse({ platforms: ["LINKEDIN"] });
  const run = (callerOrg: string) => (): Promise<Observation> => {
    const world = recruitingWorld();
    const publisher = new JobBoardPublisherService(world.db, NO_CREDENTIALS);
    const jobs = new RecruitmentJobsService(world.db, cache, standIn({}), publisher, standIn({}));
    return tenantBound(world, probe(callerOrg, [JOB_A]), () => jobs.publish(callerOrg, JOB_A, body), {
      lookup: "job_postings",
      writes: { table: "job_board_postings", verb: "insert" },
    }, () => ({
      publicationNamesTheCheckedJob: world.writes
        .filter((write) => write.table === "job_board_postings")
        .every((write) => typeof write.values === "object" && write.values !== null && "jobPostingId" in write.values && write.values.jobPostingId === JOB_A),
    }));
  };
  const entry = "RecruitmentJobsService.publish(orgId) -> JobBoardPublisherService.queue(orgId) <- POST /hr/recruitment/jobs/:jobId/publish";
  return pair(
    { ...TENANT_ONLY, resource: "hr:job-board-publication", action: "queue" },
    "hr-job-board-publication-queue",
    { because: "the caller's own open job is resolved and its board publication row is upserted under the caller's org", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the publisher is reached only after the job resolves under the caller's org, so another organisation's job id answers 404 and no publication row is written",
      bindings: [{ adapter: "service", entry, run: run(victimOf(ORG_A)) }],
    },
  );
}

export function recruitmentPipelineIsolationScenarios(): Scenario[] {
  return [...assessments(), ...bgv(), ...chatNotify(), ...erasure(), ...sandbox(), ...boardPublishing()];
}
