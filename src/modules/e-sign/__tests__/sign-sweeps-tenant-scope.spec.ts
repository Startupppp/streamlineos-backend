import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SignEnvelopeSweepsService } from "../sign-envelope-sweeps.service";
import type { Db } from "../../../db/drizzle.module";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

/**
 * The sweeps were reading every tenant's envelopes.
 *
 * The module isolates tenants with an explicit `org_id` predicate on every
 * query. (This header used to add "and nothing else — no `sign_*` table is under
 * RLS"; that was true when measured and is not now. Every `sign_*` table carries
 * the `tenant_isolation` policy today, swept in by
 * `0378_rls_remaining_tenant_tables`, which names no table and so answers no
 * grep. RLS is a backstop; the predicate below is still the contract.)
 * `runReminderSweep` and
 * `runExpirationSweep` were the only two methods in the service that took no
 * `orgId` and filtered on none, which meant an admin pressing "run now" in one
 * organisation re-issued signing tokens for recipients in **all** of them, and
 * expired **their** envelopes.
 *
 * So this asserts the predicate itself, rendered to SQL, rather than asserting
 * that the method was called. A mock that records a call is satisfied by a
 * sweep with no `WHERE` at all — which is exactly the state being fixed.
 */
const dialect = new PgDialect();

function renderedWhere(where: SQL | undefined) {
  if (!where) return { sql: "", params: [] as unknown[] };
  const query = dialect.sqlToQuery(where);
  return { sql: query.sql, params: query.params };
}

interface Capture {
  envelopeWhere: SQL | undefined;
}

function makeDb(capture: Capture, rows: unknown[] = []): Db {
  return {
    query: {
      signEnvelopes: {
        findMany: jest.fn(async (args: { where?: SQL }) => {
          capture.envelopeWhere = args.where;
          return rows;
        }),
        findFirst: jest.fn(async () => undefined),
      },
      users: { findFirst: jest.fn(async () => undefined) },
    },
    update: jest.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  } as unknown as Db;
}

function makeService(db: Db): SignEnvelopeSweepsService {
  const noop = jest.fn();
  return new SignEnvelopeSweepsService(
    db,
    { record: noop } as never,
    { generateSigningToken: noop, hash: noop, buildSigningUrl: noop } as never,
    { sendReminder: noop } as never,
    { listForEnvelope: jest.fn(async () => []) } as never,
    { emitEnvelopeEvent: noop } as never,
  );
}

describe("e-sign sweeps are tenant-scoped", () => {
  it("binds the caller's org into the reminder sweep predicate", async () => {
    const capture: Capture = { envelopeWhere: undefined };
    await makeService(makeDb(capture)).runReminderSweep(ORG_A);

    const { sql, params } = renderedWhere(capture.envelopeWhere);
    expect(sql).toContain('"org_id"');
    expect(params).toContain(ORG_A);
    expect(params).not.toContain(ORG_B);
  });

  it("binds the caller's org into the expiration sweep predicate", async () => {
    const capture: Capture = { envelopeWhere: undefined };
    await makeService(makeDb(capture)).runExpirationSweep(ORG_B);

    const { sql, params } = renderedWhere(capture.envelopeWhere);
    expect(sql).toContain('"org_id"');
    expect(params).toContain(ORG_B);
    expect(params).not.toContain(ORG_A);
  });

  it("keeps the status and reminder-enabled filters alongside the org", async () => {
    /*
     * A scoping fix that quietly widened what the sweep acts on would be worse
     * than the bug: it would remind every sent envelope regardless of whether
     * the tenant asked for reminders at all.
     */
    const capture: Capture = { envelopeWhere: undefined };
    await makeService(makeDb(capture)).runReminderSweep(ORG_A);

    const { sql, params } = renderedWhere(capture.envelopeWhere);
    expect(sql).toContain('"reminder_enabled"');
    expect(sql).toContain('"status"');
    expect(params).toEqual(
      expect.arrayContaining([ORG_A, "sent", "delivered", "partially_completed"]),
    );
  });

  it("filters expiry by a bound timestamp rather than sweeping every open envelope", async () => {
    const capture: Capture = { envelopeWhere: undefined };
    await makeService(makeDb(capture)).runExpirationSweep(ORG_A);

    const { sql, params } = renderedWhere(capture.envelopeWhere);
    expect(sql).toContain('"expires_at"');
    expect(params.some((p) => p instanceof Date || typeof p === "string")).toBe(true);
  });
});
