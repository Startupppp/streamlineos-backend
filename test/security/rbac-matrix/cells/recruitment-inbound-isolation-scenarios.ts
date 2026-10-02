import { createHmac } from "node:crypto";
import type { Table } from "drizzle-orm";
import { candidateDocumentsVault, candidates, jobBoardPostings, jobPostings, organizations } from "src/db/schema";
import { CareersService } from "src/modules/careers/careers.service";
import type { StorageService } from "src/modules/storage/storage.service";
import { BgvService } from "src/modules/hr/recruitment/bgv/bgv.service";
import { BgvCallbackService } from "src/modules/hr/recruitment/bgv/bgv-callback.service";
import { BoardApplyIngressService } from "src/modules/hr/recruitment/boards/board-apply-ingress.service";
import type { Observation, Scenario } from "../matrix.types";
import { audit } from "../adapters/real-services";
import { tenantBound } from "../adapters/hr-adapter";
import { ORG_A, ORG_B } from "../standings";
import { mergeRows, standIn, worldDb, type Row, type WorldDb } from "../world-db";
import { TENANT_ONLY, pair, reached } from "./isolation-kit";
import { CANDIDATE_A, CANDIDATE_B, candidateRow, credentialsWith } from "./recruitment-pipeline-isolation-scenarios";

const SLUG_A = "org-a";
const SECRET_A = "inbound-secret-a";
const REFERENCE_A = "case-a";
const REFERENCE_B = "case-b";
const JOB_A = 7801;
const JOB_B = 7802;
const APPLICATION = "app-1";
const PLATFORM = "LINKEDIN";

function inboundWorld(): WorldDb {
  const agencyCase = { bgvStatus: "INITIATED", bgvSource: "AGENCY" };
  return worldDb(
    mergeRows(
      new Map<Table, Row[]>([
        [
          organizations,
          [
            { id: ORG_A, slug: SLUG_A, status: "ACTIVE", deletedAt: null, region: "primary" },
            { id: ORG_B, slug: "org-b", status: "ACTIVE", deletedAt: null, region: "primary" },
          ],
        ],
        [
          candidates,
          [
            candidateRow(CANDIDATE_A, ORG_A, { ...agencyCase, bgvReference: REFERENCE_A, externalId: `${PLATFORM}:${APPLICATION}` }),
            candidateRow(CANDIDATE_B, ORG_B, { ...agencyCase, bgvReference: REFERENCE_B }),
          ],
        ],
        [
          jobPostings,
          [
            { id: JOB_A, orgId: ORG_A, status: "OPEN", title: "Engineer", screeningQuestions: [], postedBy: null },
            { id: JOB_B, orgId: ORG_B, status: "OPEN", title: "Designer", screeningQuestions: [], postedBy: null },
          ],
        ],
        [jobBoardPostings, []],
        [candidateDocumentsVault, []],
      ]),
    ),
    { mutable: true },
  );
}

function signed(body: string): string {
  return `sha256=${createHmac("sha256", SECRET_A).update(body).digest("hex")}`;
}

function untouched(world: WorldDb, id: number, orgId: string): boolean {
  return (world.rows.get(candidates) ?? []).some((row) => row.id === id && row.orgId === orgId && row.bgvStatus === "INITIATED");
}

function bgvCallback(): Scenario[] {
  const run = (reference: string) => (): Promise<Observation> => {
    const world = inboundWorld();
    const credentials = credentialsWith({ [ORG_A]: SECRET_A });
    const service = new BgvCallbackService(world.db, new BgvService(world.db, audit, credentials), credentials);
    const body = JSON.stringify({ reference, outcome: "CLEAR" });
    return tenantBound(
      world,
      { callerOrg: ORG_A, victimOrg: ORG_B, ids: [reference] },
      () => service.receive(SLUG_A, body, signed(body)),
      { lookup: "candidates", writes: { table: "candidates", verb: "update" } },
      () => ({ victimCandidateUntouched: untouched(world, CANDIDATE_B, ORG_B) }),
    );
  };
  const entry = "BgvCallbackService.receive(orgSlug) <- POST /public/bgv-callback/:orgSlug";
  return pair(
    { ...TENANT_ONLY, resource: "hr:bgv-agency-callback", action: "record-verdict" },
    "hr-bgv-agency-callback",
    { because: "a signed verdict naming the slug organisation's own case reference clears that organisation's candidate", bindings: [{ adapter: "service", entry, run: run(REFERENCE_A) }] },
    {
      because: "the case reference is resolved only under the organisation whose slug and secret signed the callback, so another organisation's reference answers 404 and its candidate is never touched",
      bindings: [{ adapter: "service", entry, run: run(REFERENCE_B) }],
    },
  );
}

function boardApply(): Scenario[] {
  const run = (jobReference: number) => (): Promise<Observation> => {
    const world = inboundWorld();
    const service = new BoardApplyIngressService(
      world.db,
      credentialsWith({ [ORG_A]: SECRET_A }),
      standIn({}),
      standIn({}),
      standIn({}),
      standIn({}),
      audit,
    );
    const body = JSON.stringify({ applicationId: APPLICATION, jobReference, candidate: { name: "Asha Rao", email: "asha@example.com" } });
    const writeMark = world.writes.length;
    return tenantBound(
      world,
      { callerOrg: ORG_A, victimOrg: ORG_B, ids: [jobReference] },
      () => service.receive(SLUG_A, PLATFORM.toLowerCase(), body, signed(body)),
      { lookup: "job_postings" },
      (value) => ({
        replayedTheCallersOwnApplication: value === undefined || (typeof value === "object" && value !== null && "replay" in value && value.replay === true),
        writesNothing: world.writes.length === writeMark,
      }),
    );
  };
  const entry = "BoardApplyIngressService.receive(orgSlug) <- POST /public/board-apply/:orgSlug/:platform";
  return pair(
    { ...TENANT_ONLY, resource: "hr:board-application", action: "ingest" },
    "hr-board-application-ingest",
    { because: "a signed delivery naming the slug organisation's own open job resolves that job and is recognised as a replay of its own application", bindings: [{ adapter: "service", entry, run: run(JOB_A) }] },
    {
      because: "the job reference is resolved only under the organisation whose slug and secret signed the delivery, so another organisation's job id answers 404 and no application is recorded against it",
      bindings: [{ adapter: "service", entry, run: run(JOB_B) }],
    },
  );
}

function resumeUpload(): Scenario[] {
  const run = (candidateId: number) => (): Promise<Observation> => {
    const world = inboundWorld();
    const stored: string[] = [];
    const storage = standIn<StorageService>({
      uploadFile: async (orgId: string, _file: Buffer, folder: string, name: string) => {
        stored.push(`${orgId}/${folder}/${name}`);
        return { key: `${orgId}/${folder}/${name}`, size: 4 };
      },
    });
    const service = new CareersService(world.db, storage);
    const vault = (): Row[] => world.rows.get(candidateDocumentsVault) ?? [];
    return reached(
      () => service.uploadResume(ORG_A, candidateId, "user-a", Buffer.from("%PDF"), "cv.pdf", "application/pdf"),
      () => vault().some((row) => row.candidateId === candidateId && row.orgId === ORG_A),
      () => ({
        storesOnlyUnderTheCallersOrg: stored.every((key) => key.startsWith(`${ORG_A}/`)),
        victimCandidateHasNoDocument: !vault().some((row) => row.candidateId === CANDIDATE_B),
      }),
    );
  };
  const entry = "CareersService.uploadResume(orgId, candidateId) <- POST /careers/resumes/upload";
  return pair(
    { ...TENANT_ONLY, resource: "hr:candidate-resume", action: "upload" },
    "hr-candidate-resume-upload",
    { because: "a recruiter attaching a resume to their own organisation's candidate stores it under that organisation and records it in the vault", bindings: [{ adapter: "service", entry, run: run(CANDIDATE_A) }] },
    {
      because: "the candidate is resolved only under the caller's organisation, so another organisation's candidate id answers 404 before a byte is stored",
      bindings: [{ adapter: "service", entry, run: run(CANDIDATE_B) }],
    },
  );
}

export function recruitmentInboundIsolationScenarios(): Scenario[] {
  return [...bgvCallback(), ...boardApply(), ...resumeUpload()];
}
