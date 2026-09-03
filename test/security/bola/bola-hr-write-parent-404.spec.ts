import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CompPlanningService } from "src/modules/hr/enterprise-comp/comp-planning.service";
import { RecruitmentJobBoardsService } from "src/modules/hr/recruitment/recruitment-job-boards.service";
import type { Db } from "src/db/drizzle.module";
import type { AuditService } from "src/common/audit/audit.service";

/**
 * Two HR writes that inserted with the id from their own path and never resolved it.
 *
 * Both are NEW findings at head. `POST /hr/recruitment/jobs/:jobId/board-postings` only became
 * visible at all because the harness learned that `:jobId` means `job_postings` under
 * `/hr/recruitment` — before that the sweep borrowed a `public.ai_jobs` id and the route answered
 * its own tenant 404, so it was filed unreachable.
 *
 * Both are the same shape as the four build 500s: the READ beside each already resolved the parent,
 * the WRITE did not, and the composite tenant foreign key refused the row with an uncaught 23503.
 * Measured live: control 201, cross-tenant **500**. A 500 is not a safe failure here — it is a
 * distinct answer from the 404 an unrelated id gets, which is an existence oracle.
 */

const CALLER_ORG = "org-b-caller";
const CALLER_USER = "user-b";
const FOREIGN_PARENT_ID = 4242;

function dbSeeing(parent: { id: number } | undefined): { db: Db; writes: () => number } {
  const state = { writes: 0 };
  const findFirst = jest.fn().mockImplementation(() => Promise.resolve(parent));
  const db = {
    query: { jobPostings: { findFirst }, hrCompCycles: { findFirst } },
    insert: jest.fn().mockImplementation(() => {
      state.writes += 1;
      return { values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) };
    }),
    select: jest.fn().mockImplementation(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }), limit: () => Promise.resolve([]) }) }),
    })),
  } as unknown as Db;
  return { db, writes: () => state.writes };
}

const writers: readonly { readonly route: string; readonly run: (db: Db) => Promise<unknown> }[] = [
  {
    route: "POST /hr/recruitment/jobs/:jobId/board-postings",
    run: (db) =>
      new RecruitmentJobBoardsService(db).create(CALLER_ORG, CALLER_USER, FOREIGN_PARENT_ID, {
        boardName: "b",
        status: "DRAFT",
      } as unknown as Parameters<RecruitmentJobBoardsService["create"]>[3]),
  },
  {
    route: "POST /hr/enterprise/comp/planning/cycles/:cycleId/budget-pools",
    run: (db) =>
      new CompPlanningService(db, { log: jest.fn() } as unknown as AuditService, {} as never).createBudgetPool(
        CALLER_ORG,
        CALLER_USER,
        { cycleId: FOREIGN_PARENT_ID, allocatedCents: 1 } as unknown as Parameters<
          CompPlanningService["createBudgetPool"]
        >[2],
      ),
  },
];

describe("BOLA probe — the HR writes that never resolved the parent in their own path", () => {
  for (const writer of writers) {
    it(`CROSS-TENANT-MISS: ${writer.route} answers NotFound, not a 500`, async () => {
      const seen = dbSeeing(undefined);
      const thrown = await writer.run(seen.db).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(NotFoundException);
      expect(thrown).not.toBeInstanceOf(ForbiddenException);
    });

    it(`NO-WRITE-ON-MISS: ${writer.route} inserts nothing, so the FK is never asked to refuse it`, async () => {
      const seen = dbSeeing(undefined);
      await writer.run(seen.db).catch(() => undefined);
      expect(seen.writes()).toEqual(0);
    });

    it(`SAME-TENANT: ${writer.route} still writes for a parent the caller holds`, async () => {
      const seen = dbSeeing({ id: FOREIGN_PARENT_ID });
      await expect(writer.run(seen.db)).resolves.toBeDefined();
      expect(seen.writes()).toEqual(1);
    });
  }
});
