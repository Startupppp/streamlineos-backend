import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { CompPlanningService } from "src/modules/hr/enterprise-comp/comp-planning.service";
import { createBudgetPoolSchema } from "src/modules/hr/enterprise-comp/dto/enterprise-comp.schemas";
import { RecruitmentJobBoardsService } from "src/modules/hr/recruitment/recruitment-job-boards.service";
import { createJobBoardPostingSchema } from "src/modules/hr/recruitment/dto/job-boards.schemas";
import type { HrAuditService } from "src/modules/hr/core/hr-audit.service";
import type { HrEffectiveChangesService } from "src/modules/hr/core/hr-effective-changes.service";
import type { Db } from "src/db/drizzle.module";

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

/**
 * Each request body is parsed through the route's OWN DTO schema, so a probe can only ever send a
 * shape production accepts.
 *
 * Both bodies previously sat behind `as unknown as Parameters<…>` and neither was real. The
 * board-posting body read `{ boardName: "b", status: "DRAFT" }`, but
 * `createJobBoardPostingSchema` is `.strict()`, has no `boardName` at all and REQUIRES `platform` —
 * so the SAME-TENANT control leg was "proving" a posting is written for a body the controller
 * would have 400'd before the service ran. The budget-pool body was already valid; its cast was
 * simply unnecessary and hid the fact. `test/` was in no typecheck, so the double cast made both
 * invisible.
 */
const JOB_BOARD_POSTING = createJobBoardPostingSchema.parse({ platform: "b", status: "DRAFT" });
const BUDGET_POOL = createBudgetPoolSchema.parse({ cycleId: FOREIGN_PARENT_ID, allocatedCents: 1 });

/**
 * `createBudgetPool` writes one audit entry and touches nothing else on the audit service. Typing
 * the double as `Partial<HrAuditService>` checks `log` against the REAL signature, so a change to
 * it fails here instead of being absorbed. This used to be typed `AuditService` (the unrelated
 * `common/audit` service) through `as unknown as`, which is what the gate caught.
 */
function auditDouble(): HrAuditService {
  const log: HrAuditService["log"] = jest.fn(() => Promise.resolve());
  const double: Partial<HrAuditService> = { log };
  return double as HrAuditService;
}

/**
 * A collaborator this path must never reach. An empty object typed as the real class means any call
 * the code grows throws here loudly; `{} as never`, which stood here, disables every check
 * downstream instead.
 */
const unreachedEffectiveChanges = {} as HrEffectiveChangesService;

function dbSeeing(parent: { id: number } | undefined): {
  db: Db;
  writes: () => Record<string, unknown>[];
} {
  const writes: Record<string, unknown>[] = [];
  const findFirst = jest.fn().mockImplementation(() => Promise.resolve(parent));
  const db = {
    query: { jobPostings: { findFirst }, hrCompCycles: { findFirst } },
    insert: jest.fn().mockImplementation(() => ({
      values: (row: Record<string, unknown>) => {
        writes.push(row);
        return { returning: () => Promise.resolve([{ id: 1, ...row }]) };
      },
    })),
    select: jest.fn().mockImplementation(() => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }), limit: () => Promise.resolve([]) }) }),
    })),
  } as unknown as Db;
  return { db, writes: () => writes };
}

const writers: readonly { readonly route: string; readonly run: (db: Db) => Promise<unknown> }[] = [
  {
    route: "POST /hr/recruitment/jobs/:jobId/board-postings",
    run: (db) =>
      new RecruitmentJobBoardsService(db).create(
        CALLER_ORG,
        CALLER_USER,
        FOREIGN_PARENT_ID,
        JOB_BOARD_POSTING,
      ),
  },
  {
    route: "POST /hr/enterprise/comp/planning/cycles/:cycleId/budget-pools",
    run: (db) =>
      new CompPlanningService(db, auditDouble(), unreachedEffectiveChanges).createBudgetPool(
        CALLER_ORG,
        CALLER_USER,
        BUDGET_POOL,
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
      expect(seen.writes()).toHaveLength(0);
    });

    it(`SAME-TENANT: ${writer.route} still writes for a parent the caller holds, bound to the caller's org`, async () => {
      const seen = dbSeeing({ id: FOREIGN_PARENT_ID });
      await expect(writer.run(seen.db)).resolves.toBeDefined();
      expect(seen.writes()).toHaveLength(1);
      expect(seen.writes()[0]).toMatchObject({ orgId: CALLER_ORG });
    });
  }
});
