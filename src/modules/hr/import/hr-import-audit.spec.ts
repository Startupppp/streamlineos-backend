/**
 * V-005. The import commit is a privileged bulk write, so the audit row it
 * leaves is the only after-the-fact answer to "who imported these 400 people,
 * and how many landed".
 *
 * `commitJob` writes one, but nothing asserted it: the call sits after the
 * transaction, and a `return` or a throw placed above it would remove the trail
 * with every other test still green. These assertions pin both halves — the row
 * is written with the ACTOR from the auth context (never an org-wide or system
 * id) and the count it carries is the number of rows actually committed, not
 * the number the preview promised.
 *
 * The second case is the one that matters: when the accounting check refuses
 * the job, no audit row may claim a commit that was rolled back.
 */
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

/** The same table-dispatching Drizzle double the accounting suite uses. */
function fakeDb(job: JobRow, validRows: Array<Record<string, unknown>>) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === hrImportJobs) return [job];
    if (table === organizations) return [{ timezone: "Asia/Kolkata" }];
    // The commit reads the valid rows twice: once for the commit order, once for the batch.
    if (table === hrImportRows) return validRows.map((payload, i) => ({ id: `row-${i}`, rowNumber: i + 1, payload }));
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

  const handle = {
    select,
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(handle),
    execute: () => Promise.resolve([]),
  };
  return handle as unknown as Db;
}

function serviceOver(
  job: JobRow,
  validRows: Array<Record<string, unknown>>,
  commitRow: HrImportCommitService["commitRow"],
) {
  const commitService = {
    commitRow,
    markRowCommitted: jest.fn().mockResolvedValue(undefined),
  } as unknown as HrImportCommitService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const cache = { invalidateNamespace: jest.fn() };
  const service = new HrImportService(
    fakeDb(job, validRows),
    audit as never,
    commitService,
    cache as never,
    { resolveMany: jest.fn() } as never,
    { invalidateAfterMutation: jest.fn() } as never,
  );
  return { service, audit };
}

describe("HR import commit audit trail", () => {
  const ORG = "org-audit";
  const ACTOR = "actor-who-pressed-commit";

  it("writes an audit row naming the actor and the committed count", async () => {
    const job: JobRow = {
      id: "job-audit-1",
      orgId: ORG,
      entity: "assets",
      status: "previewed",
      totalRows: 3,
      validRows: 3,
      errorRows: 0,
    };
    const commitRow = jest
      .fn()
      .mockResolvedValueOnce({ table: "assets", id: 1, outcome: "created" })
      .mockResolvedValueOnce({ table: "assets", id: 2, outcome: "updated" })
      .mockRejectedValueOnce(new Error("No user found for email ghost@example.test"));

    const { service, audit } = serviceOver(
      job,
      [{ a: 1 }, { b: 2 }, { c: 3 }],
      commitRow as never,
    );
    await service.commitJob(ORG, ACTOR, job.id);

    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry["orgId"]).toBe(ORG);
    // The person, not the organisation and not a system id.
    expect(entry["actorId"]).toBe(ACTOR);
    expect(entry["entityType"]).toBe("hr_import_job");
    expect(entry["entityId"]).toBe(job.id);
    expect(entry["action"]).toBe("committed");
    // Two of three rows landed. The trail must say two, not the three the
    // preview promised.
    expect(entry["after"]).toEqual({ committed: 2 });
  });

  it("writes no audit row when the commit is refused and rolled back", async () => {
    // The preview promised two rows; the scan only reaches one, so the
    // accounting check refuses the job. Nothing was written, so nothing may be
    // audited as written.
    const job: JobRow = {
      id: "job-audit-2",
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

    const { service, audit } = serviceOver(job, [{ a: 1 }], commitRow as never);
    await expect(service.commitJob(ORG, ACTOR, job.id)).rejects.toThrow();
    expect(audit.log).not.toHaveBeenCalled();
  });
});
