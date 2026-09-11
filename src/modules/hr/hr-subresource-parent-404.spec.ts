import { NotFoundException } from "@nestjs/common";
import { CalibrationService } from "./performance/calibration.service";
import { FeedbackService } from "./performance/feedback.service";
import { HrPolicyConflictService } from "./policies/hr-policy-conflict.service";
import { RecruitmentCalibrationService } from "./recruitment/recruitment-calibration.service";
import { RecruitmentReferralChecksService } from "./recruitment/recruitment-referral-checks.service";
import { RecruitmentJobBoardsService } from "./recruitment/recruitment-job-boards.service";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeDb(parent: Record<string, unknown> | undefined) {
  const rows: unknown[] = [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const key of ["from", "where", "orderBy", "limit", "offset", "innerJoin", "leftJoin", "groupBy"])
    chain[key] = jest.fn(self);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  const findFirst = jest.fn().mockResolvedValue(parent);
  const findMany = jest.fn().mockResolvedValue(rows);
  return {
    query: {
      reviewCycles: { findFirst },
      organizationMembers: { findFirst },
      hrPolicies: { findFirst, findMany },
      candidates: { findFirst },
      calibrationSessions: { findMany },
      jobPostings: { findFirst },
    },
    select: jest.fn(self),
  } as unknown as Db;
}

describe("hr — a sub-resource read whose parent id is outside the caller's org answers 404", () => {
  const cases: Array<[string, (db: Db, org: string) => Promise<unknown>]> = [
    [
      "GET /hr/performance/calibration/cycles/:cycleId/entries",
      (db, org) => new CalibrationService(db).listEntries(org, 1),
    ],
    ["GET /hr/feedback/results/:subjectId", (db, org) => new FeedbackService(db).getResults(org, "u-1")],
    [
      "GET /hr/policies/:policyId/conflicts",
      (db, org) => new HrPolicyConflictService(db).detectConflicts(org, 1),
    ],
    [
      "GET /hr/recruitment/candidates/:candidateId/calibration",
      (db, org) => new RecruitmentCalibrationService(db).listCalibration(org, 1),
    ],
    [
      "GET /hr/recruitment/candidates/:candidateId/referral",
      (db, org) => new RecruitmentReferralChecksService(db).listReferrals(org, 1),
    ],
    [
      "GET /hr/recruitment/jobs/:jobId/board-postings",
      (db, org) => new RecruitmentJobBoardsService(db).list(org, 1),
    ],
  ];

  it.each(cases)("%s refuses a parent the org does not own", async (_name, call) => {
    await expect(call(makeDb(undefined), ATTACKER_ORG)).rejects.toThrow(NotFoundException);
  });

  it.each(cases)("%s still runs for a parent the org owns (control)", async (_name, call) => {
    await expect(
      call(makeDb({ id: 1, policyType: "leave", scopes: [], priority: 1 }), OWNER_ORG),
    ).resolves.toBeDefined();
  });
});
