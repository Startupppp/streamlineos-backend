jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(),
  runInTenantTransaction: jest.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import type { Db } from "../../../db/drizzle.types";
import { CrmMailboxService } from "./crm-mailbox.service";
import { signPayload } from "./mailbox-push";

const mockedRunInNewTx = runInNewTenantTransaction as jest.MockedFunction<
  typeof runInNewTenantTransaction
>;

const dialect = new PgDialect();
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "migrations");
const RESOLVER = "resolve_crm_mailbox_sync_org_id";
const PRECEDENT = "resolve_calendar_connection_org_id";

const ORG = "org-mailbox-guc";
const SYNC_ID = "mbx-1";
const ADDRESS = "sales@example.com";
const SECRET = "push-secret-value";

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
  ) as { entries: Array<{ when: number; tag: string }> };
  const ordered = [...journal.entries].sort((a, b) => a.when - b.when);
  const create = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app\.${name}\s*\(`,
    "i",
  );
  const drop = new RegExp(
    String.raw`DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?app\.${name}\b`,
    "i",
  );
  const grant = new RegExp(
    String.raw`GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+app\.${name}`,
    "i",
  );

  let state: ResolverState | null = null;
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

describe("crm mailbox push — migration corpus defines the tenant resolver", () => {
  it("the calendar-connection precedent replays as SECURITY DEFINER granted to the app role", () => {
    // Anti-vacuity. That resolver is correct at head, so if the replay cannot see it,
    // a green result for the mailbox resolver below would prove nothing at all.
    const precedent = replayResolver(PRECEDENT);

    expect(precedent).not.toBeNull();
    expect(precedent?.securityDefiner).toBe(true);
    expect(precedent?.grantsAppRole).toBe(true);
  });

  it("a database built to head defines app.resolve_crm_mailbox_sync_org_id", () => {
    const state = replayResolver(RESOLVER);

    expect(state).not.toBeNull();
    expect(state?.securityDefiner).toBe(true);
    expect(state?.grantsAppRole).toBe(true);
  });

  it("never exposes push_secret through the RLS bypass, because that is the key a forged delivery would need", () => {
    const state = replayResolver(RESOLVER);
    const body = stripSqlComments(
      readFileSync(join(MIGRATIONS_DIR, `${state?.createdBy ?? ""}.sql`), "utf8"),
    );
    // The body the function actually executes, not the prose around it — the
    // migration header names `push_secret` on purpose, to say why it is withheld.
    const functionBody = /AS\s+\$\$([\s\S]*?)\$\$/.exec(body)?.[1] ?? "";

    expect(functionBody).toMatch(/organization_id/i);
    expect(functionBody).not.toMatch(/push_secret/i);
  });
});

interface MailboxRow {
  crmMailboxSyncId: string;
  organizationId: string;
  provider: "gmail" | "outlook";
  mailboxAddress: string;
  pushSecret: string | null;
  enabled: boolean;
}

interface Harness {
  db: Db;
  untenantedExecutes: string[];
  txOrgIds: string[];
}

/**
 * A database handle that behaves the way the real one does for an untenanted request.
 *
 * `select()` on the pool RAISES 42501 — that is not pessimism, it is what
 * `app.current_org_id()` does when `app.organization_id` is unset, and
 * `crm_mailbox_sync` is behind exactly that policy. Only the transaction handed out
 * by `runInNewTenantTransaction` can read the row.
 */
function makeHarness(rows: MailboxRow[]): Harness {
  const untenantedExecutes: string[] = [];
  const txOrgIds: string[] = [];

  const denied = () => {
    const error: Error & { code?: string } = new Error(
      "no tenant context: app.organization_id is not set for this transaction",
    );
    error.code = "42501";
    return Promise.reject(error);
  };

  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  };

  mockedRunInNewTx.mockImplementation(async (_db, orgId, cb) => {
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
      // Render the real Drizzle fragment rather than trusting a shape: the service must
      // be sending SQL that names the resolver, not merely calling `execute`.
      const text = dialect.sqlToQuery(statement).sql;
      untenantedExecutes.push(text);
      // Only a SECURITY DEFINER function can answer without a GUC.
      if (!text.includes(RESOLVER)) return denied();
      return Promise.resolve([{ org_id: rows.length > 0 ? rows[0].organizationId : null }]);
    }),
  };

  return { db: db as unknown as Db, untenantedExecutes, txOrgIds };
}

function aMailbox(overrides: Partial<MailboxRow> = {}): MailboxRow {
  return {
    crmMailboxSyncId: SYNC_ID,
    organizationId: ORG,
    provider: "gmail",
    mailboxAddress: ADDRESS,
    pushSecret: SECRET,
    enabled: true,
    ...overrides,
  };
}

function aService(harness: Harness): {
  service: CrmMailboxService;
  sync: jest.SpyInstance;
} {
  const service = new CrmMailboxService(
    harness.db,
    {} as never,
    {} as never,
    {} as never,
  );
  const sync = jest
    .spyOn(service, "sync")
    .mockResolvedValue(undefined as never);
  return { service, sync };
}

const BODY = JSON.stringify({ provider: "gmail", resource: ADDRESS });

describe("crm mailbox push — a public delivery resolves its tenant without a GUC", () => {
  beforeEach(() => {
    mockedRunInNewTx.mockReset();
  });

  it("sweeps the mailbox instead of raising 42501, because the tenant is resolved before any RLS table is read", async () => {
    const harness = makeHarness([aMailbox()]);
    const { service, sync } = aService(harness);

    await service.push(BODY, signPayload(SECRET, BODY));

    expect(sync).toHaveBeenCalledWith(ORG, SYNC_ID);
  });

  it("never issues an untenanted row read against crm_mailbox_sync", async () => {
    const harness = makeHarness([aMailbox()]);
    const { service } = aService(harness);

    await service.push(BODY, signPayload(SECRET, BODY));

    // The org must come from the resolver, and the row itself only from inside a
    // tenant transaction. A `select()` on the pool is the defect being fixed.
    expect(harness.untenantedExecutes.join("\n")).toContain(RESOLVER);
    expect(harness.txOrgIds).toEqual([ORG]);
    // The defect verbatim: reading the row off the pool. Pinned directly so a
    // revert fails here even if the harness ever stopped raising 42501 for it.
    expect(harness.db.select).not.toHaveBeenCalled();
  });

  it("drops a delivery naming a mailbox that resolves to no tenant, without opening a transaction", async () => {
    const harness = makeHarness([]);
    const { service, sync } = aService(harness);

    await service.push(BODY, signPayload(SECRET, BODY));

    expect(sync).not.toHaveBeenCalled();
    expect(harness.txOrgIds).toHaveLength(0);
  });

  it("still refuses a correctly addressed delivery carrying a bad signature, after the tenant was opened", async () => {
    const harness = makeHarness([aMailbox()]);
    const { service, sync } = aService(harness);

    await service.push(BODY, signPayload("not-the-secret", BODY));

    // The tenant WAS opened — so this is the signature check refusing, not the
    // lookup failing earlier for an unrelated reason.
    expect(harness.txOrgIds).toEqual([ORG]);
    expect(sync).not.toHaveBeenCalled();
  });
});
