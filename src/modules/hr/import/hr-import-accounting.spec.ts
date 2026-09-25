/**
 * V-004. The commit's accounting check was a tautology.
 *
 * It asserted `created + updated + unchanged + failed !== committed + failed`,
 * which cancels to `created + updated + unchanged !== committed` — and the same
 * `if (ref)` block that incremented `committed` incremented `outcomes[...]`, so
 * the two sides were the same number by construction and the check could never
 * fire. What it was meant to catch is a row that writes NOTHING: it landed in no
 * bucket, kept `status = 'valid'` forever, and the job still reported a
 * committed count over it — a silently dropped row reported as success.
 *
 * The second half is the job's own arithmetic. `errorRows: failed` threw away
 * everything the preview had found, so a five-row file with three validation
 * errors recorded `errorRows: 0` and the server's counters no longer added up
 * to `totalRows`.
 *
 * Both assertions below fail against the old code: the first because the
 * tautology let a no-op row through as "committed", the second because the
 * preview's error count was discarded.
 */
import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { organizations } from "../../../db/schema";
import { hrImportJobs, hrImportRows } from "../../../db/schema/hr/import-jobs";
import { HrImportService } from "./hr-import.service";
import type { HrImportCommitService } from "./hr-import-commit.service";

interface JobRow {
  id: string;
  orgId: string;
  entity: string;
  status: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
}

/**
 * A Drizzle double that dispatches on the table, so `commitJob` can run its real
 * control flow. Every select is a thenable builder; `transaction` invokes its
 * callback (BE-136), and a nested `transaction` is the row savepoint.
 */
function fakeDb(job: JobRow, validRows: Array<Record<string, unknown>>) {
  const jobUpdates: Array<Record<string, unknown>> = [];
  const rowUpdates: Array<Record<string, unknown>> = [];
  let rowsServed = false;

  const rowsFor = (table: unknown): unknown[] => {
    if (table === hrImportJobs) return [job];
    if (table === organizations) return [{ timezone: "Asia/Kolkata" }];
    if (table === hrImportRows) {
      if (rowsServed) return [];
      rowsServed = true;
      return validRows.map((payload, i) => ({ id: `row-${i}`, payload }));
    }
    return [];
  };

  const select = () => {
    let table: unknown;
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(rowsFor(table)).then(resolve),
    };
    for (const method of ["where", "orderBy", "limit", "innerJoin", "leftJoin"]) {
      builder[method] = () => builder;
    }
    builder["from"] = (t: unknown) => {
      table = t;
      return builder;
    };
    return builder;
  };

  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      if (table === hrImportJobs) jobUpdates.push(values);
      if (table === hrImportRows) rowUpdates.push(values);
      return { where: () => Promise.resolve(undefined) };
    },
  });

  const handle = {
    select,
    update,
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(handle),
    execute: () => Promise.resolve([]),
  };

  return { db: handle as unknown as Db, jobUpdates, rowUpdates };
}

function serviceOver(
  job: JobRow,
  validRows: Array<Record<string, unknown>>,
  commitRow: HrImportCommitService["commitRow"],
) {
  const { db, jobUpdates, rowUpdates } = fakeDb(job, validRows);
  const commitService = {
    commitRow,
    markRowCommitted: jest.fn().mockResolvedValue(undefined),
  } as unknown as HrImportCommitService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const cache = { invalidateNamespace: jest.fn() };
  const service = new HrImportService(db, audit as never, commitService, cache as never);
  return { service, jobUpdates, rowUpdates };
}

describe("HR import commit accounting", () => {
  const ORG = "org-accounting";
  const ACTOR = "actor-1";

  it("marks the job failed when a previewed-valid row wrote nothing", async () => {
    // The preview promised two valid rows; the commit scan only ever reaches
    // one. The second is in no bucket, still `status='valid'`, and nothing but
    // this check notices — the old comparison reduced to `x === x`.
    const job: JobRow = {
      id: "job-1",
      orgId: ORG,
      entity: "assets",
      status: "previewed",
      totalRows: 2,
      validRows: 2,
      errorRows: 0,
    };
    const commitRow = jest
      .fn()
      .mockResolvedValue({ table: "assets", id: 1, outcome: "created" });

    const { service, jobUpdates } = serviceOver(job, [{ a: 1 }], commitRow as never);

    await expect(service.commitJob(ORG, ACTOR, "job-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const last = jobUpdates[jobUpdates.length - 1];
    expect(last?.["status"]).toBe("failed");
    // Positive control (BE-141): the job must never be recorded as committed.
    expect(jobUpdates.map((u) => u["status"])).not.toContain("committed");
  });

  it("turns a commit that returns no outcome into a row error, not a silent success", async () => {
    const job: JobRow = {
      id: "job-3",
      orgId: ORG,
      entity: "assets",
      status: "previewed",
      totalRows: 1,
      validRows: 1,
      errorRows: 0,
    };
    const commitRow = jest.fn().mockResolvedValue(null);

    const { service, jobUpdates, rowUpdates } = serviceOver(job, [{ a: 1 }], commitRow as never);
    await service.commitJob(ORG, ACTOR, "job-3");

    expect(rowUpdates[0]?.["status"]).toBe("error");
    expect(String(rowUpdates[0]?.["error"])).toContain("wrote nothing");
    const final = jobUpdates[jobUpdates.length - 1];
    // Zero writes is a failure, not a commit reported over an empty table.
    expect(final?.["status"]).toBe("failed");
    expect(final?.["validRows"]).toBe(0);
  });

  it("records validation errors and commit failures so the counters add up to the row count", async () => {
    // Five rows: three the preview rejected, two it passed — and one of those
    // two throws at commit.
    const job: JobRow = {
      id: "job-2",
      orgId: ORG,
      entity: "leave_balances",
      status: "previewed",
      totalRows: 5,
      validRows: 2,
      errorRows: 3,
    };
    const commitRow = jest
      .fn()
      .mockResolvedValueOnce({ table: "leave_balances", id: 7, outcome: "created" })
      .mockRejectedValueOnce(new Error("Leave type 'Sabbatical' not found"));

    const { service, jobUpdates } = serviceOver(job, [{ a: 1 }, { b: 2 }], commitRow as never);
    await service.commitJob(ORG, ACTOR, "job-2");

    const final = jobUpdates[jobUpdates.length - 1];
    expect(final?.["status"]).toBe("committed");
    expect(final?.["validRows"]).toBe(1);
    // 3 from the preview + 1 that failed at commit. The old code wrote 1.
    expect(final?.["errorRows"]).toBe(4);
    expect(Number(final?.["validRows"]) + Number(final?.["errorRows"])).toBe(job.totalRows);
  });
});
