jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { runInNewTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CalendarProviderWebhookService } from "./calendar-provider-webhook.service";
import type { Db } from "../../db/drizzle.module";

const mockedRunInTx = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const dialect = new PgDialect();
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "migrations");
const RESOLVER = "resolve_calendar_connection_org_id";
const PRECEDENT = "resolve_git_connection_org_id";

const ORG = "org-webhook-guc";
const CONNECTION_ID = 7;
const EXT_ID = "google-evt-guc";
const LOCAL_UPDATED_AT = new Date("2026-09-01T12:00:00Z");
const PROVIDER_UPDATED_AT = new Date(LOCAL_UPDATED_AT.getTime() + 5_000).toISOString();

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
