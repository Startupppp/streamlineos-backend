import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { signBulkSendJobs } from "../../../db/schema";
import { SignBulkSendService } from "../sign-bulk-send.service";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../db/drizzle.module";
import type { CreateBulkSendJobInput } from "../dto/e-sign.schemas";

/*
 * The transaction is the subject here, so it is the one thing that must not be
 * a no-op double. This replaces `runInNewTenantTransaction` with a fake that
 * really does roll back — it snapshots the in-memory store on entry and
 * restores it if the body throws.
 *
 * A `jest.fn()` that merely invokes its callback would pass every assertion
 * below while proving nothing, because nothing would ever be undone.
 */
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

const ORG = "org-bulk-tx";
const USER = "user-sender";
const TEMPLATE = 42;
const JOB = 900;

const dialect = new PgDialect();
const whereParams = (where: SQL | undefined): unknown[] =>
  where ? dialect.sqlToQuery(where).params : [];

interface JobRow {
  id: number;
  orgId: string;
  status: string;
  totalCount: number;
  successCount: number;
  failedCount: number;
  completedAt: Date | null;
}
interface BulkRow {
  rowNumber: number;
  status: string;
  envelopeId: number | null;
  errorMessage: string | null;
}
interface Store {
  jobs: Map<number, JobRow>;
  rows: Map<number, BulkRow>;
  envelopes: Set<number>;
}

interface HarnessOptions {
  /** Row whose `envelopes.send` throws, as a provider would. */
  failRow?: number;
  /**
   * Whether that row's invitation had already left before the throw. "after"
   * is the irreversible case the whole change is about.
   */
  failMode?: "before-email" | "after-email";
  /** Row whose *outcome write* throws — the infrastructure-died-mid-run case. */
  throwOnRowStatusWrite?: number;
  /** Template lifecycle state; anything but "published" is rejected up front. */
  templateStatus?: string;
}

function makeHarness(opts: HarnessOptions = {}) {
  const store: Store = { jobs: new Map(), rows: new Map(), envelopes: new Set() };
  /*
   * Deliberately outside the store, and therefore never rolled back. An email
   * in a recipient's inbox is not a row, and modelling it as one would hide the
   * asymmetry this spec exists to pin down.
   */
  const sentEmails: number[] = [];
  const rowOfEnvelope = new Map<number, number>();

  let depth = 0;
  let maxDepth = 0;
  let txCount = 0;
  let nextEnvelopeId = 1000;

  const snapshot = (): Store => ({
    jobs: new Map([...store.jobs].map(([k, v]) => [k, { ...v }])),
    rows: new Map([...store.rows].map(([k, v]) => [k, { ...v }])),
    envelopes: new Set(store.envelopes),
  });

  (runInNewTenantTransaction as jest.Mock).mockImplementation(
    async (_db: unknown, orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
      // Every transaction here is opened for the caller's own organisation.
      expect(orgId).toBe(ORG);
      txCount += 1;
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      const before = snapshot();
      try {
        return await fn({});
      } catch (error) {
        store.jobs = before.jobs;
        store.rows = before.rows;
        store.envelopes = before.envelopes;
        throw error;
      } finally {
        depth -= 1;
      }
    },
  );

  /** `.values(...)`/`.where(...)` are awaited directly in some call sites and
   *  chained into `.returning()` in others, so the builder answers to both. */
  const thenable = <T>(run: () => Promise<T>) => {
    let pending: Promise<T> | null = null;
    const go = () => (pending ??= run());
    return {
      then: (res: (v: T) => unknown, rej: (e: unknown) => unknown) => go().then(res, rej),
      returning: () => go(),
    };
  };

  const db = {
    query: {
      signBulkSendJobs: {
        findMany: async () => [],
        findFirst: async () => store.jobs.get(JOB) ?? null,
      },
      signBulkSendRows: {
        findMany: async () =>
          [...store.rows.values()].sort((a, b) => a.rowNumber - b.rowNumber),
      },
      users: {
        findFirst: async () => ({ id: USER, email: "sender@example.com", name: "Sender" }),
      },
    },
    insert: (table: unknown) => ({
      values: (vals: unknown) =>
        thenable(async () => {
          if (table === signBulkSendJobs) {
            const input = vals as { totalCount: number; status: string };
            const job: JobRow = {
              id: JOB,
              orgId: ORG,
              status: input.status,
              totalCount: input.totalCount,
              successCount: 0,
              failedCount: 0,
              completedAt: null,
            };
            store.jobs.set(JOB, job);
            return [job];
          }
          for (const r of vals as { rowNumber: number; status: string; errorMessage?: string }[]) {
            store.rows.set(r.rowNumber, {
              rowNumber: r.rowNumber,
              status: r.status,
              envelopeId: null,
              errorMessage: r.errorMessage ?? null,
            });
          }
          return [];
        }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: SQL) =>
          thenable(async () => {
            const params = whereParams(where);
            if (table === signBulkSendJobs) {
              const job = store.jobs.get(Number(params[0]));
              if (job) Object.assign(job, patch);
              return job ? [job] : [];
            }
            const rowNumber = Number(params[params.length - 1]);
            if (opts.throwOnRowStatusWrite === rowNumber)
              throw new Error("connection terminated while recording the row outcome");
            const row = store.rows.get(rowNumber);
            if (row) Object.assign(row, patch);
            return row ? [row] : [];
          }),
      }),
    }),
    select: () => ({ from: () => ({ where: async () => [{ n: String(store.rows.size) }] }) }),
  };

  const templates = {
    get: jest.fn(async () => ({
      id: TEMPLATE,
      name: "NDA",
      status: opts.templateStatus ?? "published",
      templateJson: {
        roles: [{ roleName: "Signer", recipientType: "signer", routingOrder: 1, authMethod: "email_link" }],
        documents: [],
        fields: [],
      },
    })),
    instantiate: jest.fn(async (_o: string, _u: string, _t: number, input: { recipients: { email?: string }[] }) => {
      const email = input.recipients[0]?.email ?? "";
      const rowNumber = Number(/^row(\d+)@/.exec(email)?.[1] ?? 0);
      const id = (nextEnvelopeId += 1);
      rowOfEnvelope.set(id, rowNumber);
      store.envelopes.add(id); // written inside the row's transaction
      return { id };
    }),
  };

  const envelopes = {
    send: jest.fn(async (_orgId: string, envelopeId: number) => {
      const rowNumber = rowOfEnvelope.get(envelopeId) ?? 0;
      if (opts.failRow === rowNumber) {
        if (opts.failMode === "after-email") sentEmails.push(rowNumber);
        throw new Error(`smtp gateway timeout on row ${rowNumber}`);
      }
      sentEmails.push(rowNumber);
    }),
  };

  const service = new SignBulkSendService(
    db as unknown as Db,
    { record: jest.fn() } as never,
    { getOrCreate: jest.fn(async () => ({ bulkSendMaxRowsPerJob: 5000, bulkSendMaxActiveJobs: 5 })) } as never,
    { sendBulkJobCompleted: jest.fn() } as never,
    templates as never,
    envelopes as never,
    { emitBulkSendCompleted: jest.fn() } as never,
  );

  return {
    service,
    store,
    sentEmails,
    /** Rows whose envelope actually survived to be committed. */
    committedRows: () => new Set([...store.envelopes].map((id) => rowOfEnvelope.get(id))),
    stats: () => ({ maxDepth, txCount }),
  };
}

function bulkInput(rowCount: number, dryRun = false): CreateBulkSendJobInput {
  return {
    templateId: TEMPLATE,
    columnMapping: { name: "Name", email: "Email" },
    rows: Array.from({ length: rowCount }, (_, i) => ({
      Name: `Row ${i + 1}`,
      Email: `row${i + 1}@example.com`,
    })),
    dryRun,
  };
}

describe("bulk send survives a failure partway through", () => {
  describe("row 3 of 5 fails after its invitation has gone out", () => {
    let h: ReturnType<typeof makeHarness>;

    beforeEach(async () => {
      h = makeHarness({ failRow: 3, failMode: "after-email" });
      await h.service.createJob(ORG, USER, bulkInput(5));
    });

    it("leaves every earlier row committed", () => {
      /*
       * The whole point. Under the one request transaction, the failure took
       * rows 1 and 2 down with it — their envelopes vanished while their
       * invitations stayed in recipients' inboxes.
       */
      expect([...h.committedRows()].sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 4, 5]);
    });

    it("records the failure even though the row's own work rolled back", () => {
      /*
       * This is what the second transaction buys, and it is the assertion that
       * fails if anyone folds the outcome write back into the row's
       * transaction: the write would roll back with the envelope it describes,
       * leaving a row that failed sitting at `pending` with no error message.
       */
      expect(h.store.rows.get(3)).toMatchObject({ status: "failed", envelopeId: null });
      expect(h.store.rows.get(3)?.errorMessage).toContain("smtp gateway timeout on row 3");
    });

    it("reports the true counts on the job row", () => {
      expect(h.store.jobs.get(JOB)).toMatchObject({
        status: "completed",
        successCount: 4,
        failedCount: 1,
      });
    });

    it("bounds the irreversible half to the one row that failed", () => {
      /*
       * `dispatch.send` sends after its own inner block but still inside the
       * row's transaction, so row 3's invitation did leave before that
       * transaction died and now describes an envelope that does not exist.
       * That residue is real and deliberate — what changed is that it is one
       * row's worth. Under a single request transaction this list was
       * [1, 2, 3]: every invitation already sent, orphaned at once.
       */
      const committed = h.committedRows();
      expect(h.sentEmails.filter((n) => !committed.has(n))).toEqual([3]);
    });

    it("opens a transaction per row rather than one around the run", () => {
      const { maxDepth, txCount } = h.stats();
      expect(maxDepth).toBe(1);
      // setup + running + (work, outcome) per row + completion + sender lookup
      expect(txCount).toBeGreaterThanOrEqual(5 * 2);
    });
  });

  it("marks the job failed, not running, when the run cannot continue", async () => {
    /*
     * Partial success removes the rollback that used to erase a half-finished
     * job, so an escaping throw needs a terminal state of its own. `running`
     * counts towards ACTIVE_JOB_STATUSES, so a job stuck there would hold one
     * of the organisation's active-job slots for ever and refuse later sends.
     */
    const h = makeHarness({ throwOnRowStatusWrite: 4 });

    await expect(h.service.createJob(ORG, USER, bulkInput(5))).rejects.toThrow(
      "connection terminated while recording the row outcome",
    );

    expect(h.store.jobs.get(JOB)).toMatchObject({ status: "failed", successCount: 3 });
    expect(h.store.jobs.get(JOB)?.status).not.toBe("running");
    // The three rows that did send are still committed and still reported.
    expect([...h.committedRows()]).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("sends nothing and creates no envelope on a dry run", async () => {
    const h = makeHarness();

    const result = await h.service.createJob(ORG, USER, bulkInput(5, true));

    expect(result.dryRun).toBe(true);
    expect(h.sentEmails).toEqual([]);
    expect(h.store.envelopes.size).toBe(0);
  });

  it("commits nothing at all when validation rejects the job", async () => {
    /*
     * Setup stayed atomic on purpose: a job row without its rows, or rows
     * without their job, is worse than no job at all. The per-row boundaries
     * begin after this point, not before it.
     */
    const h = makeHarness({ templateStatus: "draft" });

    await expect(h.service.createJob(ORG, USER, bulkInput(5))).rejects.toThrow(
      "Only published templates can be used for bulk send",
    );

    expect(h.store.jobs.size).toBe(0);
    expect(h.store.rows.size).toBe(0);
    expect(h.sentEmails).toEqual([]);
  });
});
