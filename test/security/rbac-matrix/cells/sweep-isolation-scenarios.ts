import type { Table } from "drizzle-orm";
import {
  candidateApplications,
  candidateMessages,
  candidates,
  emailSequenceEnrollments,
  emailSequenceSteps,
  emailSequences,
  expenses,
  kbIndexedBytesQuota,
  projectAttachments,
  projectRetentionSettings,
} from "src/db/schema";
import type { AuditService } from "src/common/audit/audit.service";
import { CronBuildProjectRetentionService } from "src/modules/cron/cron-build-project-retention.service";
import { CronRecruitmentSequencesService } from "src/modules/cron/cron-recruitment-sequences.service";
import type { EmailService } from "src/modules/email/email.service";
import type { EmailSuppressionService } from "src/modules/email/email-suppression.service";
import { ExpensesImportService } from "src/modules/expenses/expenses-import.service";
import { importSchema } from "src/modules/expenses/dto/expense-import.schemas";
import { KbIndexedBytesQuotaService } from "src/modules/kb/core/kb-indexed-bytes-quota.service";
import type { StorageService } from "src/modules/storage/storage.service";
import type { StoragePendingPurgeService } from "src/modules/storage/storage-pending-purge.service";
import type { Observation, Scenario } from "../matrix.types";
import { ORG_A, ORG_B } from "../standings";
import { boundValues, standIn, type Row, type WorldDb } from "../world-db";
import { TENANT_ONLY, boundBy, markOf, pair, reached, standingWorld, victimOf } from "./isolation-kit";

const RETAINED_PROJECT = 8001;
const EXPIRED_ATTACHMENT = 8201;
const ENROLLMENT = 8301;
const SEQUENCE = 8401;
const NURTURED_CANDIDATE = 8501;
const NURTURED_EMAIL = "nurtured@example.com";
const IMPORTED_EXPENSE = 8601;
const IMPORTER = "importer-in-two-orgs";
const LONG_AGO = new Date("2026-01-01T00:00:00Z");
const ENROLLED = new Date("2026-08-01T00:00:00Z");

function rowsWhere(world: WorldDb, table: Table, id: number): Row | undefined {
  return (world.rows.get(table) ?? []).find((row) => row.id === id);
}

function sweepPair(resource: string, action: string, id: string, entry: string, run: (foreign: boolean) => () => Promise<Observation>, because: { readonly allow: string; readonly deny: string }): Scenario[] {
  return pair(
    { ...TENANT_ONLY, resource, action },
    id,
    { because: because.allow, bindings: [{ adapter: "job", entry, run: run(false) }] },
    { because: because.deny, bindings: [{ adapter: "job", entry, run: run(true) }] },
  );
}

function retentionSweep(): Scenario[] {
  const run = (foreign: boolean) => async (): Promise<Observation> => {
    const owner = foreign ? ORG_B : ORG_A;
    const world = standingWorld(
      new Map<Table, Row[]>([
        [
          projectRetentionSettings,
          [
            {
              id: 8101,
              orgId: ORG_A,
              projectId: RETAINED_PROJECT,
              inheritOrgPolicy: false,
              closedTicketRetentionDays: null,
              attachmentRetentionDays: 30,
              legalHold: false,
              legalHoldReason: null,
            },
          ],
        ],
        [projectAttachments, [{ id: EXPIRED_ATTACHMENT, orgId: owner, projectId: RETAINED_PROJECT, deletedAt: LONG_AGO, storageKey: `${owner}/files/expired.pdf` }]],
      ]),
    );
    const removed: Array<{ readonly orgId: string; readonly key: string }> = [];
    const service = new CronBuildProjectRetentionService(
      world.db,
      standIn<AuditService>({ logCriticalOutsideTransaction: async () => undefined }),
      standIn<StorageService>({
        deleteFileIfPresent: async (orgId: string, key: string) => {
          removed.push({ orgId, key });
        },
      }),
      standIn<StoragePendingPurgeService>({ markConfirmed: async () => undefined, markFailed: async () => undefined }),
    );
    const mark = markOf(world);
    return reached(
      () => service.sweep({ confirm: true, now: new Date("2026-10-01T00:00:00Z") }),
      () => rowsWhere(world, projectAttachments, EXPIRED_ATTACHMENT) === undefined || removed.length > 0,
      () => {
        const bound = boundBy(world, mark, "project_attachments");
        return {
          attachmentStatementsBindTheSweptOrg: bound.includes(ORG_A),
          attachmentStatementsNeverBindTheOtherOrg: !bound.includes(ORG_B),
          objectDeletedOnlyForTheSettingsOwner: foreign ? removed.length === 0 : removed.length === 1 && removed[0].orgId === ORG_A,
          foreignAttachmentSurvives: !foreign || rowsWhere(world, projectAttachments, EXPIRED_ATTACHMENT) !== undefined,
        };
      },
    );
  };
  return sweepPair(
    "build:retention-sweep",
    "purge",
    "build-retention-sweep-purge",
    "CronBuildProjectRetentionService.sweep(confirm) <- build-project-retention cron",
    run,
    {
      allow: "an organisation's own retention policy purges its own attachment deleted past the cutoff, row and stored object",
      deny: "another organisation's expired attachment on the same project id is outside the purge predicate, so it and its stored object survive the first organisation's policy",
    },
  );
}

function nurtureRows(owner: string): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [
      emailSequenceEnrollments,
      [{ id: ENROLLMENT, orgId: ORG_A, sequenceId: SEQUENCE, candidateId: NURTURED_CANDIDATE, currentStep: 0, enrolledAt: ENROLLED, status: "ACTIVE", nextSendAt: ENROLLED }],
    ],
    [emailSequences, [{ id: SEQUENCE, orgId: owner, isActive: true, name: "Nurture" }]],
    [candidates, [{ id: NURTURED_CANDIDATE, orgId: owner, email: NURTURED_EMAIL, firstName: "Nia", lastName: "Nurtured", status: "NEW" }]],
    [candidateApplications, [{ id: 8502, orgId: owner, candidateId: NURTURED_CANDIDATE, consentAt: LONG_AGO, appliedAt: LONG_AGO }]],
    [candidateMessages, []],
    [emailSequenceSteps, [{ id: 8402, orgId: owner, sequenceId: SEQUENCE, stepOrder: 0, subject: "Hello", htmlBody: "<p>Hello</p>", delayDays: 2 }]],
  ]);
}

function nurtureSweep(): Scenario[] {
  const run = (foreign: boolean) => async (): Promise<Observation> => {
    const world = standingWorld(nurtureRows(foreign ? ORG_B : ORG_A));
    const mailed: string[] = [];
    const service = new CronRecruitmentSequencesService(
      world.db,
      standIn<EmailService>({
        sendEmail: async (input: { readonly to: string }) => {
          mailed.push(input.to);
        },
      }),
      standIn<EmailSuppressionService>({ findSuppressed: async () => new Set<string>() }),
    );
    const mark = markOf(world);
    return reached(
      () => service.sendDueSequenceSteps(),
      () => mailed.includes(NURTURED_EMAIL),
      () => {
        const sequenceBound = boundBy(world, mark, "email_sequences");
        const recorded = world.writes.slice(mark.writes).filter((write) => write.table === "candidate_messages");
        return {
          sequenceLookupBindsTheEnrollmentOrg: sequenceBound.includes(ORG_A) && sequenceBound.includes(SEQUENCE),
          sequenceLookupNeverBindsTheOtherOrg: !sequenceBound.includes(ORG_B),
          foreignCandidateNeverMailed: !foreign || mailed.length === 0,
          messageRecordedOnlyForTheOwnCandidate: foreign
            ? recorded.length === 0
            : recorded.length === 1 && typeof recorded[0].values === "object" && recorded[0].values !== null && Reflect.get(recorded[0].values, "orgId") === ORG_A,
        };
      },
    );
  };
  return sweepPair(
    "hr:nurture-sequence",
    "send-step",
    "hr-nurture-sequence-send-step",
    "CronRecruitmentSequencesService.sendDueSequenceSteps() <- recruitment-sequence-steps cron",
    run,
    {
      allow: "a due enrollment whose sequence and candidate belong to its own organisation sends the next step and records it",
      deny: "an enrollment naming another organisation's sequence and candidate ids resolves neither under its own org, so nothing is mailed to the foreign candidate and nothing is recorded",
    },
  );
}

function expenseImport(): Scenario[] {
  const input = importSchema.parse({ fileName: "expenses.csv", content: "date,amount,category,merchant\n2026-09-10,125.00,Travel,Cab Co" });
  const run = (callerOrg: string) => async (): Promise<Observation> => {
    const world = standingWorld(
      new Map<Table, Row[]>([
        [expenses, [{ id: IMPORTED_EXPENSE, orgId: ORG_A, userId: IMPORTER, expenseDate: "2026-09-10", amount: "125.00", category: "Travel", merchant: "Cab Co" }]],
      ]),
    );
    const service = new ExpensesImportService(world.db);
    const mark = markOf(world);
    let matched: unknown[] = [];
    return reached(
      async () => {
        const result = await service.importExpenses(callerOrg, IMPORTER, input);
        matched = result.duplicateWarnings.map((warning) => warning.matchesExpenseId);
      },
      () => matched.includes(IMPORTED_EXPENSE),
      () => {
        const bound = boundBy(world, mark, "expenses");
        const inserted = world.writes.slice(mark.writes).filter((write) => write.verb === "insert" && write.table === "expenses");
        return {
          duplicateReadBindsCallerOrg: bound.includes(callerOrg),
          duplicateReadNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)),
          foreignExpenseIdNeverDisclosed: callerOrg === ORG_A || matched.length === 0,
          insertsCarryCallerOrg: inserted.every((write) => Array.isArray(write.values) && write.values.every((value: unknown) => typeof value === "object" && value !== null && Reflect.get(value, "orgId") === callerOrg)),
        };
      },
    );
  };
  const entry = "ExpensesImportService.importExpenses(orgId) <- POST /expenses/import";
  return pair(
    { ...TENANT_ONLY, resource: "expenses:import", action: "detect-duplicates" },
    "expenses-import-duplicate-detection",
    { because: "a re-imported row matching the importer's own expense in its own organisation is flagged with that expense's id and not inserted again", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "the same person importing the same row in another organisation is matched only against that organisation's expenses, so the first organisation's expense id is never disclosed and the row is filed under the caller's org",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function quotaRelease(): Scenario[] {
  const run = (callerOrg: string) => async (): Promise<Observation> => {
    const world = standingWorld(new Map<Table, Row[]>([[kbIndexedBytesQuota, [{ orgId: ORG_A, indexedBytes: 4096, limitBytes: 8192 }]]]));
    const before = (world.rows.get(kbIndexedBytesQuota) ?? [])[0];
    const service = new KbIndexedBytesQuotaService(world.db);
    const mark = markOf(world);
    return reached(
      () => service.release(callerOrg, 1024),
      () => (world.rows.get(kbIndexedBytesQuota) ?? [])[0] !== before,
      () => {
        const writes = world.writes.slice(mark.writes).filter((write) => write.table === "kb_indexed_bytes_quota");
        const bound = writes.flatMap((write) => boundValues(write.where));
        return {
          releaseBindsCallerOrg: writes.length === 1 && bound.includes(callerOrg),
          releaseNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)),
        };
      },
    );
  };
  const entry = "KbIndexedBytesQuotaService.release(orgId) <- KB source removal and the stuck-source reaper";
  return pair(
    { ...TENANT_ONLY, resource: "kb:indexed-bytes-quota", action: "release" },
    "kb-indexed-bytes-quota-release",
    { because: "releasing bytes in the organisation that holds the quota row decrements that row", bindings: [{ adapter: "service", entry, run: run(ORG_A) }] },
    {
      because: "a release in another organisation updates only its own quota row, so the first organisation's indexed-bytes counter is never decremented",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

export function sweepIsolationScenarios(): Scenario[] {
  return [...retentionSweep(), ...nurtureSweep(), ...expenseImport(), ...quotaRelease()];
}
