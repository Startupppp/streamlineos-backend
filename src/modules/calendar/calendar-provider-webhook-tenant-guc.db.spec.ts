/**
 * The regression net for the P0 that made `POST /webhooks/calendar/provider` answer 500
 * to every well-formed, correctly-secreted delivery.
 *
 * THE DEFECT. `CalendarProviderWebhookController` is `@Public()`. With no session,
 * `TenantContextInterceptor.resolveTenant` returns null, the interceptor calls
 * `next.handle()` WITHOUT opening a tenant transaction, and `createTenantAwareDb`
 * (tenant-db.ts:20) therefore falls through to the raw pool with no ambient context.
 * `handleDelivery` opened with a bare `this.db.select().from(userIntegrationConnections)`
 * on that handle. `user_integration_connections` carries `relrowsecurity = t` with
 * `USING (org_id = app.current_org_id())`, and `app.current_org_id()` RAISES 42501 when
 * `app.organization_id` is unset rather than returning NULL. Measured against
 * scratch_head_1010 as `streamline_app` with no GUC:
 *
 *   ERROR:  no tenant context: app.organization_id is not set for this transaction
 *   CONTEXT:  PL/pgSQL function current_org_id() line 7 at RAISE
 *
 * So a valid Google/Outlook change notification 500s, the provider retries, it 500s
 * again, and the drift-reconciliation half of PRD-C129 never executes for any tenant.
 * The route is unreachable in both configurations: unset secret 503s, set secret 500s.
 *
 * THE FIX is the shape this repo already uses for exactly this problem — an inbound
 * webhook that must find its tenant before it holds one. Migrations 0385/0386/0387
 * introduced `app.resolve_project_org_id`, `app.resolve_survey_session_org_id` and
 * `app.resolve_git_connection_org_id`: SECURITY DEFINER, owner-owned, returning the
 * org id and NOTHING else, EXECUTE granted to the app role. The connection row itself
 * is then re-read inside `runInNewTenantTransaction(orgId, …)`, where RLS is live and
 * the status/toolkit predicate is enforced. Widening the table's own policy with an
 * `id`-keyed arm was rejected for the reason 0387's header already gives: it would
 * grant blanket read of the FULL row to every unguarded id-only query, and this table
 * holds `composio_connected_account_id`.
 *
 * WHY THE EXISTING SPECS COULD NOT SEE IT. `calendar-provider-webhook-delivery.spec.ts`
 * hands the service a `db` whose `select()` is a jest mock resolving to a connection
 * array (lines 84-97). A mock answers whatever it was told to; it cannot raise the
 * policy error that the real pool raises. Both halves below are written so that the
 * MODEL of the database refuses an untenanted read, which is the one property the
 * existing fake gets wrong.
 *
 *   CORPUS — no database. Replays the journalled migration corpus and asserts a
 *   database built to head defines the resolver. Runs in the default suite.
 *
 *   SERVICE — no database. Drives the real `CalendarProviderWebhookService` against a
 *   handle that models the two access paths faithfully: the untenanted pool RAISES
 *   42501 exactly as Postgres does, and only a tenant transaction can read rows.
 *   Runs in the default suite and is red without the fix.
 *
 *   CATALOG — the real thing, in the house `.db.spec.ts` style. Proves against a live
 *   Postgres as the non-owner app role that the bare read is denied, that the resolver
 *   answers without a GUC, that it is SECURITY DEFINER and executable by the app role,
 *   and that it exposes org_id alone. Every write is rolled back.
 *
 *     CALENDAR_DB_TESTS=1 APP_DATABASE_URL=postgresql://streamline_app:…@…/scratch_head_1010 \
 *       npx jest --runInBand --testPathPattern="calendar-provider-webhook-tenant-guc"
 */
jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CalendarProviderWebhookService } from "./calendar-provider-webhook.service";
import type { Db } from "../../db/drizzle.module";

const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const dialect = new PgDialect();
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "migrations");
const RESOLVER = "resolve_calendar_connection_org_id";
/** The precedent that WAS wired at head — the anti-vacuity control for every probe. */
const PRECEDENT = "resolve_git_connection_org_id";

const ORG = "org-webhook-guc";
const CONNECTION_ID = 7;
const EXT_ID = "google-evt-guc";
const LOCAL_UPDATED_AT = new Date("2026-09-01T12:00:00Z");
const PROVIDER_UPDATED_AT = new Date(LOCAL_UPDATED_AT.getTime() + 5_000).toISOString();

/* ------------------------------------------------------------------ CORPUS */

interface ResolverState {
  defined: boolean;
  securityDefiner: boolean;
  grantsAppRole: boolean;
  createdBy: string;
}

function stripSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Replays every journalled migration in applied order and reports the surviving
 * definition of `app.<name>`. A .sql file absent from `_journal.json` never runs, so
 * the journal — not the directory listing — is what a bootstrapped database sees.
 */
function replayResolver(name: string): ResolverState | null {
  const journal: { entries: Array<{ when: number; tag: string }> } = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  );
  const ordered = [...journal.entries].sort((a, b) => a.when - b.when);
  const create = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app\.${name}\s*\(`,
    "i",
  );
  const drop = new RegExp(String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?app\.${name}\b`, "i");

  const grant = new RegExp(String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.${name}`, "i");

  let state: ResolverState | null = null;
  // The grant survives `CREATE OR REPLACE`, so it is tracked across the whole corpus
  // rather than per-file: 0387 grants `resolve_git_connection_org_id` and 0432 later
  // replaces the body without re-granting, which is correct and must stay green here.
  let granted = false;
  for (const entry of ordered) {
    const raw = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
    const body = stripSqlComments(raw);
    if (drop.test(body)) {
      state = null;
      granted = false;
    }
    if (grant.test(body)) granted = true;
    if (create.test(body))
      state = {
        defined: true,
        securityDefiner: /SECURITY\s+DEFINER/i.test(body),
        grantsAppRole: false,
        createdBy: entry.tag,
      };
  }
  return state === null ? null : { ...state, grantsAppRole: granted };
}

describe("calendar provider webhook — migration corpus defines the tenant resolver", () => {
  it("the git-connection precedent replays as SECURITY DEFINER granted to the app role", () => {
    // Anti-vacuity. This resolver was correct at head. If the replay cannot see it, a
    // green result for the calendar resolver below would prove nothing at all.
    const precedent = replayResolver(PRECEDENT);

    expect(precedent).not.toBeNull();
    expect(precedent?.securityDefiner).toBe(true);
    expect(precedent?.grantsAppRole).toBe(true);
  });

  it("a database built to head defines app.resolve_calendar_connection_org_id", () => {
    const state = replayResolver(RESOLVER);

    expect(state).not.toBeNull();
    expect(state?.securityDefiner).toBe(true);
    expect(state?.grantsAppRole).toBe(true);
  });
});

/* ----------------------------------------------------------------- SERVICE */

interface EventRow {
  id: number;
  updatedAt: Date;
  localVersion: number;
  integrationConnectionId: number | null;
  externalEventId: string;
  createdByMembershipId: number;
}

interface ConnectionRow {
  id: number;
  orgId: string;
  status: string;
  toolkit: string;
}

interface Harness {
  db: Db;
  /** Every SQL text handed to `db.execute` on the untenanted pool. */
  untenantedExecutes: string[];
  /** Rows written to calendar_provider_sync_queue. */
  inserted: Record<string, unknown>[];
  txOrgIds: string[];
}

/**
 * A database handle that behaves the way the real one does for an untenanted request.
 *
 * `select()` on the pool RAISES 42501 — that is not pessimism, it is what
 * `app.current_org_id()` does when `app.organization_id` is unset, reproduced verbatim
 * in the CATALOG half below. Only the transaction handed out by
 * `runInNewTenantTransaction` can read rows, and it applies the connection predicate
 * itself so a non-calendar or inactive connection is still refused.
 */
function makeHarness(options: { connections: ConnectionRow[]; events: EventRow[] }): Harness {
  const { connections, events } = options;
  const untenantedExecutes: string[] = [];
  const inserted: Record<string, unknown>[] = [];
  const txOrgIds: string[] = [];

  const denied = () => {
    const error: Error & { code?: string } = new Error(
      "no tenant context: app.organization_id is not set for this transaction",
    );
    error.code = "42501";
    return Promise.reject(error);
  };

  const activeCalendarConnections = connections.filter(
    (row) => row.status === "active" && (row.toolkit === "googlecalendar" || row.toolkit === "outlook"),
  );

  let txSelectCall = 0;
  const tx = {
    select: jest.fn().mockImplementation(() => {
      const call = txSelectCall++;
      return {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            // call 0 is the connection re-read under RLS, call 1 the event lookup,
            // call 2 the pending-sync probe.
            limit: jest
              .fn()
              .mockResolvedValue(call === 0 ? activeCalendarConnections : call === 1 ? events : []),
          }),
        }),
      };
    }),
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ userId: "user-owner" }) },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve([]);
      }),
    }),
  };

  mockedRunInTx.mockImplementation(async (_db, orgId, cb) => {
    txOrgIds.push(orgId);
    return cb(tx as never);
  });

  const db = {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockImplementation(denied) }),
      }),
    })),
    execute: jest.fn().mockImplementation((statement: SQL) => {
      // Render the real Drizzle fragment rather than trusting a shape: the service
      // must be sending SQL that names the resolver, not merely calling `execute`.
      const text = dialect.sqlToQuery(statement).sql;
      untenantedExecutes.push(text);
      // Only a SECURITY DEFINER function can answer without a GUC.
      if (!text.includes(RESOLVER)) return denied();
      const known = connections.length > 0 ? ORG : null;
      return Promise.resolve([{ org_id: known }]);
    }),
  };

  return { db: db as unknown as Db, untenantedExecutes, inserted, txOrgIds };
}

function anEvent(): EventRow {
  return {
    id: 900,
    updatedAt: LOCAL_UPDATED_AT,
    localVersion: 3,
    integrationConnectionId: CONNECTION_ID,
    externalEventId: EXT_ID,
    createdByMembershipId: 11,
  };
}

function aConnection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return { id: CONNECTION_ID, orgId: ORG, status: "active", toolkit: "googlecalendar", ...overrides };
}

describe("calendar provider webhook — a public delivery resolves its tenant without a GUC", () => {
  beforeEach(() => {
    mockedRunInTx.mockReset();
  });

  it("reconciles provider drift instead of raising 42501", async () => {
    const harness = makeHarness({ connections: [aConnection()], events: [anEvent()] });
    const service = new CalendarProviderWebhookService(harness.db);

    const result = await service.handleDelivery({
      connectionId: CONNECTION_ID,
      externalEventId: EXT_ID,
      providerUpdatedAtIso: PROVIDER_UPDATED_AT,
    });

    expect(result).toEqual({ action: "requeued" });
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({ orgId: ORG, operation: "update" });
  });

  it("never issues an untenanted row read against user_integration_connections", async () => {
    const harness = makeHarness({ connections: [aConnection()], events: [anEvent()] });
    const service = new CalendarProviderWebhookService(harness.db);

    await service.handleDelivery({
      connectionId: CONNECTION_ID,
      externalEventId: EXT_ID,
      providerUpdatedAtIso: PROVIDER_UPDATED_AT,
    });

    // The org must come from the resolver, and the row itself only from inside a
    // tenant transaction. A `select()` on the pool is the defect being fixed.
    expect(harness.untenantedExecutes.join("\n")).toContain(RESOLVER);
    expect(harness.txOrgIds).toContain(ORG);
  });

  it("still refuses a connection that is inactive or not a calendar toolkit", async () => {
    // The predicate did not move to the resolver — it moved under RLS, where it is
    // enforced against the real row rather than against an id the caller supplied.
    for (const connection of [
      aConnection({ status: "needs_reauth" }),
      aConnection({ toolkit: "gmail" }),
    ]) {
      const harness = makeHarness({ connections: [connection], events: [anEvent()] });
      const service = new CalendarProviderWebhookService(harness.db);

      const result = await service.handleDelivery({
        connectionId: CONNECTION_ID,
        externalEventId: EXT_ID,
        providerUpdatedAtIso: PROVIDER_UPDATED_AT,
      });

      expect(result).toEqual({ action: "unknown_connection" });
      expect(harness.inserted).toHaveLength(0);
    }
  });

  it("drops a delivery for an id that resolves to no tenant at all", async () => {
    const harness = makeHarness({ connections: [], events: [anEvent()] });
    const service = new CalendarProviderWebhookService(harness.db);

    const result = await service.handleDelivery({
      connectionId: 4242,
      externalEventId: EXT_ID,
      providerUpdatedAtIso: PROVIDER_UPDATED_AT,
    });

    expect(result).toEqual({ action: "unknown_connection" });
    expect(harness.txOrgIds).toHaveLength(0);
  });
});

/* ----------------------------------------------------------------- CATALOG */

const ENABLED = process.env.CALENDAR_DB_TESTS === "1";
const DB_URL = process.env.CALENDAR_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

/** Drizzle and postgres-js both wrap driver errors; the SQLSTATE can be on `.cause`. */
function sqlstateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describeDb("calendar connection resolver — real catalog, non-owner role", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(() => {
    sql = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("connects as a role RLS actually applies to", async () => {
    // Anti-vacuity: as an owner with rolbypassrls the denial below cannot happen, so a
    // green suite would mean nothing. Refuse to pass on the wrong role.
    const rows = await sql`select rolbypassrls from pg_roles where rolname = current_user`;
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("is SECURITY DEFINER, owner-owned, and executable by the app role", async () => {
    const rows = await sql`
      select p.prosecdef,
             pg_get_userbyid(p.proowner) as owner,
             has_function_privilege(current_user, p.oid, 'EXECUTE') as executable,
             pg_get_function_result(p.oid) as result_type
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app' and p.proname = ${RESOLVER}`;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.prosecdef).toBe(true);
    expect(rows[0]?.executable).toBe(true);
    // org_id and nothing else: this path must never widen to the whole row, which
    // carries composio_connected_account_id.
    expect(rows[0]?.result_type).toBe("text");
  });

  it("answers with no tenant GUC, where the bare row read is denied 42501", async () => {
    await sql.begin(async (tx) => {
      const [org] = await tx`select id from organizations order by id limit 1`;
      if (!org) throw new Error("scratch database has no organization to probe with");
      const orgId: string = String(org.id);

      // Seed one connection inside the transaction, with the GUC set so the policy's
      // WITH CHECK admits the write.
      await tx`select set_config('app.organization_id', ${orgId}, true)`;
      const [connection] = await tx`
        insert into user_integration_connections
          (org_id, user_id, toolkit, composio_connected_account_id, status)
        values (${orgId}, 'probe-user', 'googlecalendar', ${"probe-" + Date.now()}, 'active')
        returning id`;
      const connectionId = Number(connection?.id);

      // Now drop the GUC: this is the state a @Public() webhook request runs in.
      await tx`select set_config('app.organization_id', '', true)`;

      // The denied read must sit in a SAVEPOINT: a failed statement aborts the whole
      // transaction (25P02) and every probe after it would fail for the wrong reason.
      let denied: unknown;
      await tx
        .savepoint(
          async (sp) =>
            sp`select id, org_id from user_integration_connections where id = ${connectionId}`,
        )
        .catch((error: unknown) => {
          denied = error;
        });
      expect(sqlstateOf(denied)).toBe("42501");

      const resolved = await tx`select app.resolve_calendar_connection_org_id(${connectionId}) as org_id`;
      expect(resolved[0]?.org_id).toBe(orgId);

      const missing = await tx`select app.resolve_calendar_connection_org_id(${-1}) as org_id`;
      expect(missing[0]?.org_id).toBeNull();

      // Leave the database as it was found.
      throw new Error("rollback");
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "rollback") throw error;
    });
  });
});
