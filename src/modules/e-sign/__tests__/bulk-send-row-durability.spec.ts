import { PgDialect } from "drizzle-orm/pg-core";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { SignBulkSendService } from "../sign-bulk-send.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, fn: () => Promise<unknown>) => fn(),
  ),
}));

/**
 * A bulk-send pass sent its invitations and then threw its own record away.
 *
 * `OutboxPublisherService.deliver` wraps `consumer.handle(event)` in
 * `runInNewTenantTransaction`, so everything a pass writes joins ONE
 * transaction. And `finishJob` ends a partly-done job by THROWING, deliberately,
 * because that is how the outbox is asked to bring the event back for another
 * pass. The consumer's own docblock says so.
 *
 * Those two facts together are the bug. The throw rolls the transaction back, so
 * a pass that sent 400 invitations and had rows left over discarded all 400
 * `success` rows, all 400 `envelope_id`s and every `attempts` increment -- while
 * the 400 emails stayed sent, because email is not transactional. The retry then
 * re-read the same rows as `pending` with `attempts` unchanged and sent every one
 * of them AGAIN. And the per-row budget that exists to stop a poison row killing
 * the worker could never advance past one, for exactly the same reason.
 *
 * Neither file shows it alone: the loop looks like it commits per row, and the
 * throw looks like a retry signal. What settles it is which transaction the
 * writes land in, so that is what these tests assert.
 */

const mockedRunInNew = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const ORG = "org-1";
const JOB_ID = 7;
/** The job's sender is a membership; the worker reads the sending user through it. */
const SENDER_MEMBERSHIP_ID = 11;

interface Recorded {
  table: string;
  values: Record<string, unknown>;
  /** Whether this write went through an independent transaction. */
  committed: boolean;
}

function harness(rows: Array<{ id: number; rowNumber: number; attempts: number }>) {
  const writes: Recorded[] = [];
  let insideCommit = 0;
  const memberLookups: unknown[] = [];

  const record = (table: string) => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        writes.push({ table, values, committed: insideCommit > 0 });
        return Promise.resolve([]);
      },
    }),
  });

  const selectChain = (result: unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy"]) chain[method] = () => chain;
    chain["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };

  /* Two `select()` calls: the pending rows, then finishJob's recount. */
  let selectCall = 0;
  const db = {
    query: {
      signBulkSendJobs: {
        findFirst: () =>
          Promise.resolve({
            id: JOB_ID,
            orgId: ORG,
            /* A queued job is `pending`; the job status enum has no "queued". */
            status: "pending",
            templateId: 1,
            senderMembershipId: SENDER_MEMBERSHIP_ID,
            columnMappingJson: { name: "name", email: "email" },
          }),
      },
      /*
        The sender is resolved once per pass as a membership inside the job's
        organisation. Recorded so the lookup's tenant predicate can be asserted.
      */
      organizationMembers: {
        findFirst: (args: { where?: unknown }) => {
          memberLookups.push(args.where);
          return Promise.resolve({
            id: SENDER_MEMBERSHIP_ID,
            orgId: ORG,
            userId: "user-1",
            user: { id: "user-1" },
          });
        },
      },
    },
    select: () => {
      selectCall += 1;
      return selectCall === 1
        ? selectChain(rows.map((r) => ({ ...r, rawDataJson: { name: "A", email: "a@b.test" }, status: "pending" })))
        : /* finishJob's recount: one row still pending, so the pass must throw. */
          selectChain([{ status: "pending" }]);
    },
    update: (table: unknown) => record(String((table as { _?: { name?: string } })?._?.name ?? "unknown")),
  } as never;

  mockedRunInNew.mockImplementation(async (_db, _orgId, fn) => {
    insideCommit += 1;
    try {
      return (await fn(undefined as never)) as never;
    } finally {
      insideCommit -= 1;
    }
  });

  /*
    Positional, and checked against the real constructor rather than guessed:
    (db, audit, settings, notifications, templates, envelopes, integrations).
    Only the three the pass actually reaches need to answer.
  */
  const stub = {} as never;
  const service = new SignBulkSendService(
    db,
    { record: () => Promise.resolve() } as never,
    stub,
    stub,
    {
      get: () =>
        Promise.resolve({
          templateJson: { roles: [{ roleName: "Signer", recipientType: "signer" }] },
        }),
    } as never,
    { send: () => Promise.resolve() } as never,
    { emitBulkSendCompleted: () => undefined } as never,
  );
  return { service, writes, memberLookups, commits: () => mockedRunInNew.mock.calls.length };
}

describe("a bulk-send pass keeps what it did, even when it throws", () => {
  beforeEach(() => jest.clearAllMocks());

  it("writes every row through an independent transaction, not the pass's", async () => {
    const { service, writes, commits } = harness([{ id: 1, rowNumber: 1, attempts: 0 }]);

    /*
      `finishJob` throws because a row is still pending -- that is the retry
      signal and it is correct. What must NOT happen is the pass's writes going
      down with it.
    */
    await expect(service.processQueuedJob(ORG, JOB_ID)).rejects.toThrow(/still pending/);

    expect(writes.length).toBeGreaterThan(0);
    /*
      The assertion the fix exists for. `runInNewTenantTransaction` calls
      `runOutsideTenantContext` first, so it is a genuinely separate transaction
      and not a SAVEPOINT -- a nested `db.transaction` would have looked
      identical here and rolled back with the pass.
    */
    for (const write of writes) expect(write.committed).toBe(true);
    expect(commits()).toBeGreaterThanOrEqual(writes.length);
  });

  it("commits the attempts increment, so a poison row's budget actually advances", async () => {
    const { service, writes } = harness([{ id: 1, rowNumber: 1, attempts: 0 }]);
    await expect(service.processQueuedJob(ORG, JOB_ID)).rejects.toThrow();

    const attempted = writes.find((w) => "attempts" in w.values);
    expect(attempted).toBeDefined();
    /*
      Counting before the attempt only protects the worker if the count SURVIVES
      the pass. Rolled back, MAX_ROW_ATTEMPTS is never reached and the row that
      is killing the worker is the one retried forever.
    */
    expect(attempted!.committed).toBe(true);
    expect(attempted!.values["attempts"]).toBe(1);
  });

  it("commits the job's own counts before throwing", async () => {
    const { service, writes } = harness([{ id: 1, rowNumber: 1, attempts: 0 }]);
    await expect(service.processQueuedJob(ORG, JOB_ID)).rejects.toThrow();

    /* The counts are what an operator watches a long job through. */
    const counts = writes.filter((w) => "successCount" in w.values);
    expect(counts).toHaveLength(1);
    expect(counts[0]!.committed).toBe(true);
  });

  it("resolves the sender as a membership inside the job's organisation", async () => {
    const { service, memberLookups } = harness([{ id: 1, rowNumber: 1, attempts: 0 }]);
    await expect(service.processQueuedJob(ORG, JOB_ID)).rejects.toThrow(/still pending/);

    /* Once per pass, bound to this org and the job's sender membership. */
    expect(memberLookups).toHaveLength(1);
    const { params } = new PgDialect().sqlToQuery(
      memberLookups[0] as Parameters<PgDialect["sqlToQuery"]>[0],
    );
    expect(params).toEqual(expect.arrayContaining([ORG, SENDER_MEMBERSHIP_ID]));
  });
});
