import { Readable } from "node:stream";
import { organizationMembers } from "src/db/schema";
import { KbPageIndexingController } from "src/modules/kb/retrieval/kb-page-indexing.controller";
import { KbIndexingService } from "src/modules/kb/retrieval/kb-indexing.service";
import { SurveyCollectorsController } from "src/modules/surveys/survey-collectors.controller";
import { SurveyCollectorService } from "src/modules/surveys/survey-collector.service";
import { HrExportController } from "src/modules/hr/import/hr-export.controller";
import { HrExportJobsService } from "src/modules/hr/import/hr-export-jobs.service";
import { AuthContextFactory } from "src/common/auth/auth-context.factory";
import type { MembershipState, MembershipStateService } from "src/common/auth/membership-state.service";
import type { StorageService } from "src/modules/storage/storage.service";
import type { Observation } from "../matrix.types";
import { accessFor, type Standing } from "../standings";
import { boundValues, standIn, type WorldDb } from "../world-db";
import { sendHttp } from "./http-adapter";
import type { AuditService } from "src/common/audit/audit.service";

interface Mark {
  readonly reads: number;
  readonly writes: number;
}

function markOf(world: WorldDb): Mark {
  return { reads: world.reads.length, writes: world.writes.length };
}

function readsOf(world: WorldDb, mark: Mark, table: string) {
  return world.reads.slice(mark.reads).filter((read) => read.table === table);
}

function writesOf(world: WorldDb, mark: Mark, table: string) {
  return world.writes.slice(mark.writes).filter((write) => write.table === table);
}

const reindexCalls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];

function indexingService(world: WorldDb): KbIndexingService {
  const service = new KbIndexingService(world.db, standIn({}), standIn({}));
  const onRequest = service.reindexPageOnRequest.bind(service);
  Reflect.set(service, "reindexPageOnRequest", async (orgId: string, pageId: number) => {
    reindexCalls.push({ method: "reindexPageOnRequest", args: [orgId, pageId] });
    return onRequest(orgId, pageId);
  });
  Reflect.set(service, "indexPage", async (orgId: string, pageId: number) => {
    reindexCalls.push({ method: "indexPage", args: [orgId, pageId] });
    return 3;
  });
  return service;
}

export async function reindexPage(world: WorldDb, standing: Standing, orgId: string, pageId: number): Promise<Observation> {
  reindexCalls.length = 0;
  const mark = markOf(world);
  const exchange = await sendHttp(world, {
    controllers: [KbPageIndexingController],
    services: [{ provide: KbIndexingService, useValue: indexingService(world) }],
    verb: "post",
    path: `/kb/pages/${pageId}/reindex`,
    permissionKey: "kb:pages:manage",
    standing,
    orgId,
  });
  const lookups = readsOf(world, mark, "kb_pages");
  const bound = lookups.flatMap((read) => boundValues(read.where));
  const allowed = exchange.outcome === "allow";
  const body = exchange.body;
  return {
    outcome: exchange.outcome,
    checks: {
      routeAskedForItsKey: exchange.asked.includes("kb:pages:manage"),
      handlerTookTheRequestPath: !exchange.guardPassed || (reindexCalls[0]?.method === "reindexPageOnRequest" && reindexCalls[0].args[0] === orgId && reindexCalls[0].args[1] === pageId),
      lookupBindsCallerOrgAndPage: !exchange.guardPassed || (lookups.length === 1 && bound.includes(orgId) && bound.includes(pageId)),
      indexesOnlyAfterTheRequestPathFoundThePage: allowed === reindexCalls.some((call) => call.method === "indexPage"),
      answersReindexedOnlyWhenFound: !allowed || (body !== null && typeof body === "object" && "reindexed" in body && body.reindexed === true),
    },
  };
}

export const COLLECTOR_INPUT = { collectorType: "public_link", name: "n" };

export async function createCollector(world: WorldDb, standing: Standing, orgId: string, surveyId: number): Promise<Observation> {
  const mark = markOf(world);
  const exchange = await sendHttp(world, {
    controllers: [SurveyCollectorsController],
    services: [{ provide: SurveyCollectorService, useValue: new SurveyCollectorService(world.db) }],
    verb: "post",
    path: `/surveys/${surveyId}/collectors`,
    body: COLLECTOR_INPUT,
    permissionKey: "surveys:participants:manage",
    standing,
    orgId,
  });
  const lookups = readsOf(world, mark, "survey_forms");
  const bound = lookups.flatMap((read) => boundValues(read.where));
  const inserts = writesOf(world, mark, "survey_collectors");
  const values = inserts[0]?.values;
  const row = values !== null && typeof values === "object" ? values : {};
  const allowed = exchange.outcome === "allow";
  return {
    outcome: exchange.outcome,
    checks: {
      routeAskedForItsKey: exchange.asked.includes("surveys:participants:manage"),
      surveyResolvedOnceUnderCallerOrg: !exchange.guardPassed || (lookups.length === 1 && bound.includes(orgId) && bound.includes(surveyId)),
      insertsOnlyWhenAllowed: allowed ? inserts.length === 1 : inserts.length === 0,
      insertedRowBindsCallerOrgAndSurvey:
        !allowed ||
        ("orgId" in row && row.orgId === orgId && "surveyId" in row && row.surveyId === surveyId && "collectorType" in row && row.collectorType === COLLECTOR_INPUT.collectorType && "name" in row && row.name === COLLECTOR_INPUT.name),
    },
  };
}

function membershipFrom(world: WorldDb): MembershipStateService {
  return standIn<MembershipStateService>({
    resolve: async (userId: string, orgId: string): Promise<MembershipState> => {
      const row = (world.rows.get(organizationMembers) ?? []).find((member) => member.orgId === orgId && member.userId === userId);
      return {
        active: row?.status === "ACTIVE",
        isOwner: row?.isOwner === true,
        role: typeof row?.role === "string" ? row.role : "MEMBER",
        membershipId: typeof row?.id === "number" ? row.id : null,
      };
    },
  });
}

const exportAudit = standIn<AuditService>({ log: () => undefined, logCriticalOutsideTransaction: async () => undefined });

const openedStreams: Array<{ readonly orgId: string; readonly key: string }> = [];

function exportJobsService(world: WorldDb): HrExportJobsService {
  const membership = membershipFrom(world);
  const storage = standIn<StorageService>({
    isConfigured: () => true,
    getFileStream: async (orgId: string, key: string) => {
      openedStreams.push({ orgId, key });
      return { body: Readable.from(["id,name\n"]), contentType: "text/csv" };
    },
  });
  const contexts = new AuthContextFactory(standIn({ moduleAvailability: async () => ({ available: true }) }), membership, standIn({}));
  return new HrExportJobsService(world.db, storage, exportAudit, accessFor(world), membership, contexts, standIn({}));
}

export async function exportJob(
  world: WorldDb,
  route: "read" | "download",
  standing: Standing,
  orgId: string,
  jobId: string,
  victimOrg: string,
): Promise<Observation> {
  openedStreams.length = 0;
  const mark = markOf(world);
  const exchange = await sendHttp(world, {
    controllers: [HrExportController],
    services: [{ provide: HrExportJobsService, useValue: exportJobsService(world) }],
    verb: "get",
    path: route === "read" ? `/hr/export/jobs/${jobId}` : `/hr/export/jobs/${jobId}/download`,
    permissionKey: "hr:export:manage",
    standing,
    orgId,
  });
  const lookups = readsOf(world, mark, "hr_export_jobs");
  const bound = lookups.flatMap((read) => boundValues(read.where));
  const allowed = exchange.outcome === "allow";
  return {
    outcome: exchange.outcome,
    checks: {
      lookupBindsCallerOrgRequesterAndJob: lookups.length >= 1 && bound.includes(orgId) && bound.includes(`${orgId}:${standing}`) && bound.includes(jobId),
      lookupNeverBindsVictimOrg: orgId === victimOrg || !bound.includes(victimOrg),
      streamOpensOnlyWhenAllowed: route === "read" || (allowed ? openedStreams.length === 1 && openedStreams[0]?.orgId === orgId : openedStreams.length === 0),
    },
  };
}
