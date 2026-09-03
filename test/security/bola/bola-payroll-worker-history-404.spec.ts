import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ProfilesService } from "src/modules/payroll/runs/profiles.service";
import type { Db } from "src/db/drizzle.module";
import type { AuditService } from "src/common/audit/audit.service";
import type { SalaryProfilesRepository } from "src/modules/payroll/runs/salary-profiles.repository";

/**
 * `GET /payroll/workers/:workerId/history` — a NEW finding at head, invisible to every previous run
 * because the sweep could not reach the route.
 *
 * `listHistoryByWorker` handed the path's worker id straight to a query filtered on `orgId` and
 * `workerId`, so another organisation's worker — and a worker belonging to nobody — both answered
 * **200 with an empty array**. Measured live: control 200 / cross-tenant 200 / absent 200. The
 * employee-addressed sibling `listHistory` has called `assertEmployeeInOrg` all along; the worker
 * half simply never had one. `GET /payroll/workers/:workerId` carried the same gap and is fixed
 * with it — it 404'd only by accident, because it happened to check whether any profile came back.
 */

const CALLER_ORG = "org-b-caller";
const FOREIGN_WORKER_ID = "worker-of-another-org";

function serviceSeeing(workerRow: Record<string, unknown> | undefined): {
  service: ProfilesService;
  historyReads: () => number;
} {
  const state = { historyReads: 0 };
  /**
   * `resolvePerson({ kind: "worker" })` reads `workers` under the org. An empty first answer is the
   * cross-tenant case; the seam re-asserts `orgId` itself, so an unowned worker looks identical to
   * one that does not exist anywhere.
   */
  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve(workerRow ? [workerRow] : []) }) }),
        leftJoin: () => ({ where: () => ({ limit: () => Promise.resolve(workerRow ? [workerRow] : []) }) }),
        where: () => ({ limit: () => Promise.resolve(workerRow ? [workerRow] : []) }),
      }),
    })),
  } as unknown as Db;
  const repository = {
    historyByWorker: jest.fn().mockImplementation(() => {
      state.historyReads += 1;
      return Promise.resolve([]);
    }),
  } as unknown as SalaryProfilesRepository;
  const service = new ProfilesService(db, {} as unknown as AuditService, repository);
  return { service, historyReads: () => state.historyReads };
}

describe("BOLA probe — GET /payroll/workers/:workerId/history", () => {
  it("CROSS-TENANT-MISS: another organisation's worker id is refused", async () => {
    const probe = serviceSeeing(undefined);
    await expect(probe.service.listHistoryByWorker(CALLER_ORG, FOREIGN_WORKER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", async () => {
    const probe = serviceSeeing(undefined);
    const thrown = await probe.service
      .listHistoryByWorker(CALLER_ORG, FOREIGN_WORKER_ID)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("NO-READ-ON-MISS: the salary history is never queried for an unowned worker", async () => {
    const probe = serviceSeeing(undefined);
    await probe.service.listHistoryByWorker(CALLER_ORG, FOREIGN_WORKER_ID).catch(() => undefined);
    expect(probe.historyReads()).toEqual(0);
  });
});
