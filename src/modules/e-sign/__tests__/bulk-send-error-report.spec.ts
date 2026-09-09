import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SignBulkSendService } from "../sign-bulk-send.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-bulk";
const JOB = 77;

interface RowStub {
  rowNumber: number;
  status: "success" | "failed" | "pending";
  errorMessage?: string;
}

/**
 * A five-hundred-row job whose failures all sit past row 100 — the shape that
 * made the old report lie. It returned the first hundred rows by row number and
 * filtered those for failures, so this job reported **nothing wrong** while its
 * own `failedCount` said 250.
 */
function job500(): RowStub[] {
  const rows: RowStub[] = [];
  for (let i = 1; i <= 500; i += 1) {
    rows.push(
      i > 200 && i <= 450
        ? { rowNumber: i, status: "failed", errorMessage: `row ${i} rejected` }
        : { rowNumber: i, status: "success" },
    );
  }
  return rows;
}

/**
 * Enough of Drizzle's relational API to answer the two reads under test,
 * honouring `where` and `limit` the way the driver does rather than returning
 * whatever the spec finds convenient — a mock that ignores `limit` cannot fail
 * the way the bug did.
 */
const dialect = new PgDialect();

function makeDb(rows: RowStub[]) {
  const captured: { limit?: number; wantedFailed?: boolean }[] = [];
  const db = {
    query: {
      signBulkSendJobs: {
        findFirst: jest.fn(async () => ({
          id: JOB,
          orgId: ORG,
          status: "completed",
          failedCount: rows.filter((r) => r.status === "failed").length,
        })),
      },
      signBulkSendRows: {
        findMany: jest.fn(async (args: { where?: SQL; limit?: number }) => {
          /*
           * Rendered through the real dialect, not JSON.stringify — a Drizzle
           * SQL object holds a circular reference back to its table. Rendering
           * it also makes this a claim about the SQL that will actually run:
           * the failed-only read binds "failed" as a parameter, the page read
           * does not.
           */
          const rendered = args.where
            ? dialect.sqlToQuery(args.where)
            : { sql: "", params: [] as unknown[] };
          const wantedFailed = rendered.params.includes("failed");
          captured.push({ limit: args.limit, wantedFailed });
          const source = wantedFailed ? rows.filter((r) => r.status === "failed") : rows;
          return source.slice(0, args.limit ?? source.length);
        }),
      },
    },
    select: () => ({
      from: () => ({ where: async () => [{ n: String(rows.length) }] }),
    }),
  };
  return { db: db as unknown as Db, captured };
}

function makeService(db: Db): SignBulkSendService {
  const noop = jest.fn();
  return new SignBulkSendService(
    db,
    { record: noop } as never,
    { getOrCreate: noop } as never,
    { sendReminder: noop } as never,
    { instantiate: noop } as never,
    { send: noop } as never,
    { emitEnvelopeEvent: noop } as never,
  );
}

describe("bulk send error report", () => {
  it("returns failures past the first page, which used to come back empty", async () => {
    const rows = job500();
    const { db } = makeDb(rows);

    const report = await makeService(db).getErrorReport(ORG, JOB);

    expect(report).toHaveLength(250);
    expect(report[0]?.rowNumber).toBe(201);
    expect(report.at(-1)?.rowNumber).toBe(450);
  });

  it("filters in SQL rather than paging rows and filtering in memory", async () => {
    /*
     * The distinction the bug turned on. Filtering after a capped page means the
     * cap is applied to ROWS and only then to failures, so the report is a
     * window over the start of the file rather than a list of what went wrong.
     */
    const { db, captured } = makeDb(job500());

    await makeService(db).getErrorReport(ORG, JOB);

    const failedRead = captured.find((c) => c.wantedFailed);
    expect(failedRead).toBeDefined();
    expect(failedRead?.limit).toBeGreaterThan(1000);
  });

  it("still resolves the job through the org check before reading its rows", async () => {
    /*
     * `sign_bulk_send_rows` is keyed only on `jobId`, so without the job lookup
     * first, anyone who guessed an id would read another tenant's failures —
     * including the recipient names and email addresses in the source file.
     */
    const { db } = makeDb(job500());
    const service = makeService(db);

    await service.getErrorReport(ORG, JOB);

    const dbAny = db as unknown as {
      query: { signBulkSendJobs: { findFirst: jest.Mock } };
    };
    expect(dbAny.query.signBulkSendJobs.findFirst).toHaveBeenCalled();
  });

  it("reports how many rows a job has, not just the page it returns", async () => {
    const { db } = makeDb(job500());

    const result = await makeService(db).getJob(ORG, JOB);

    expect(result.rows).toHaveLength(100);
    expect(result.rowTotal).toBe(500);
  });
});
