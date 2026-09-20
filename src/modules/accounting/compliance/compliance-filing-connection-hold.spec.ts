/**
 * Filing an e-invoice reaches a government IRP with a 15s budget
 * (`live-irp.adapter.ts`). `TenantContextInterceptor` wraps every authenticated
 * request in one Postgres transaction held for the request's whole lifetime,
 * and the pool is 10 on RDS — so before this change a single filing pinned a
 * tenth of an instance's concurrency for the length of a government outage,
 * idle in transaction, where `statement_timeout` cannot reach it.
 *
 * The opt-out alone would have been worse than the hold. `gl_books` and
 * `gl_document_compliance` are both RLS-enabled
 * (`0591_tenant_isolation_for_unprotected_tables.sql:742,768`) and
 * `app.current_org_id()` RAISES `42501` when the GUC is unset, so a handler
 * that merely dropped the request transaction would have failed every filing on
 * its first statement.
 *
 * These run the REAL `runInNewTenantTransaction` against a recording double, so
 * they read the property that matters rather than asserting the shape of the
 * code: every statement runs inside a transaction that set
 * `app.organization_id` first, and the adapter round trip runs inside none.
 */
import { NO_TENANT_TRANSACTION } from "../../../common/tenant/no-tenant-transaction.decorator";
import { getTenantContext } from "../../../common/tenant/tenant-context";
import { primeRelocationTrafficTracker } from "../../../common/relocation/relocation-traffic-tracker";
import type { Db } from "../../../db/drizzle.module";
import type { BooksService } from "../kernel/books.service";
import { ComplianceController } from "./compliance.controller";
import { ComplianceService } from "./compliance.service";
import type {
  ComplianceTransportAdapter,
  TransportResult,
} from "./transport/compliance-transport.port";

const ORG = "org-compliance-filing";
const BOOK = "book-1";

interface Recorded {
  openTransactions: number;
  configuredOrgIds: string[];
  events: string[];
  statementsWithNoTenantContext: string[];
}

function chain(result: unknown[], onRun: () => void): unknown {
  const link: Record<string, unknown> = {};
  for (const method of ["from", "where", "limit", "orderBy"]) link[method] = () => link;
  link.then = (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve()
      .then(() => {
        onRun();
        return result;
      })
      .then(resolve, reject);
  return link;
}

function makeDb(selects: unknown[][]): { db: Db; recorded: Recorded } {
  const recorded: Recorded = {
    openTransactions: 0,
    configuredOrgIds: [],
    events: [],
    statementsWithNoTenantContext: [],
  };
  const queue = [...selects];

  const record = (event: string): void => {
    recorded.events.push(event);
    if (!getTenantContext()) recorded.statementsWithNoTenantContext.push(event);
  };

  const tx = {
    execute: async (query: unknown) => {
      const text = JSON.stringify(query);
      if (/set_config[^]*?organization_id/.test(text)) {
        const org = /org-[a-z0-9-]+/.exec(text)?.[0];
        if (org) recorded.configuredOrgIds.push(org);
      }
      return [];
    },
    select: () => {
      record("select");
      return chain(getTenantContext() ? (queue.shift() ?? []) : [], () => undefined);
    },
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async () => {
          record("insert");
          return [];
        },
      }),
    }),
  };

  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      recorded.openTransactions += 1;
      return fn(tx);
    },
    ...tx,
  } as unknown as Db;

  return { db, recorded };
}

function makeBooks(recorded: Recorded): BooksService {
  return {
    findDefault: async () => {
      recorded.events.push("findDefault");
      if (!getTenantContext())
        throw new Error("42501: the book lookup ran with no tenant context");
      return { id: BOOK };
    },
  } as unknown as BooksService;
}

const ACCEPTED: TransportResult = {
  outcome: "accepted",
  authorityId: "112420000000123",
  ackNo: "112420000000123",
  ackAt: new Date("2026-09-20T00:00:00.000Z"),
};

function makeAdapter(recorded: Recorded): ComplianceTransportAdapter {
  return {
    transport: "mock_irp",
    isConfigured: () => true,
    describe: () => ({ transport: "mock_irp", files: false, reason: "test double" }),
    submit: async () => {
      recorded.events.push("submit");
      if (getTenantContext())
        throw new Error("the IRP round trip ran inside a tenant transaction");
      return ACCEPTED;
    },
  } as unknown as ComplianceTransportAdapter;
}

const PENDING_STATE = [
  {
    transport: "irp",
    status: "pending",
    authorityId: null,
    ackNo: null,
    ackAt: null,
    errors: null,
    cancelledAt: null,
  },
];

const AR_DOCUMENT = [
  {
    documentNumber: "INV-1",
    issueDate: "2026-09-01",
    currency: "INR",
    grossMinor: 118000,
    partyId: "party-1",
  },
];

function readyToFile(): unknown[][] {
  return [
    PENDING_STATE,
    [],
    AR_DOCUMENT,
    [{ number: "29AABCU9603R1ZM" }],
    [{ number: "29AAACX1234R1Z5" }],
    PENDING_STATE,
  ];
}

describe("filing an e-invoice does not hold a pooled connection across the IRP round trip", () => {
  beforeEach(() => {
    primeRelocationTrafficTracker([], Date.now());
  });

  it("is opted out of the request transaction, because the IRP has a 15s budget", () => {
    expect(
      Reflect.getMetadata(NO_TENANT_TRANSACTION, ComplianceController.prototype.submitDocument),
    ).toBe(true);
  });

  it("ANTI-VACUITY: the read beside it is NOT opted out, so the check reads real metadata", () => {
    expect(
      Reflect.getMetadata(NO_TENANT_TRANSACTION, ComplianceController.prototype.getForDocument),
    ).toBeUndefined();
  });

  it("calls the adapter with no transaction open, which is the whole point of the change", async () => {
    const { db, recorded } = makeDb(readyToFile());
    const service = new ComplianceService(db, makeBooks(recorded));

    const filing = await service.fileDocument(ORG, "sales_invoice", "doc-1", makeAdapter(recorded));

    expect(filing.outcome).toBe("filed");
    expect(recorded.events).toContain("submit");
  });

  it("sets app.organization_id in every transaction it opens, so an RLS read cannot 42501", async () => {
    const { db, recorded } = makeDb(readyToFile());
    const service = new ComplianceService(db, makeBooks(recorded));

    await service.fileDocument(ORG, "sales_invoice", "doc-1", makeAdapter(recorded));

    expect(recorded.openTransactions).toBe(2);
    expect(recorded.configuredOrgIds).toEqual([ORG, ORG]);
  });

  it("issues no statement outside a tenant context, which is what would 42501 under RLS", async () => {
    const { db, recorded } = makeDb(readyToFile());
    const service = new ComplianceService(db, makeBooks(recorded));

    await service.fileDocument(ORG, "sales_invoice", "doc-1", makeAdapter(recorded));

    expect(recorded.statementsWithNoTenantContext).toEqual([]);
    expect(recorded.events.filter((event) => event !== "findDefault").length).toBeGreaterThan(4);
  });

  it("ANTI-VACUITY: the same read issued off the injected db IS recorded as context-less", async () => {
    const { db, recorded } = makeDb(readyToFile());
    const service = new ComplianceService(db, makeBooks(recorded));

    await service.get(ORG, BOOK, "sales_invoice", "doc-1");

    expect(recorded.statementsWithNoTenantContext).toEqual(["select"]);
  });

  it("reads before the round trip and writes after it, so neither transaction spans the network", async () => {
    const { db, recorded } = makeDb(readyToFile());
    const service = new ComplianceService(db, makeBooks(recorded));

    await service.fileDocument(ORG, "sales_invoice", "doc-1", makeAdapter(recorded));

    const submitAt = recorded.events.indexOf("submit");
    const insertAt = recorded.events.indexOf("insert");
    expect(submitAt).toBeGreaterThan(recorded.events.indexOf("findDefault"));
    expect(insertAt).toBeGreaterThan(submitAt);
  });

  it("opens no second transaction when the document is already registered with the authority", async () => {
    const onFile = [
      {
        status: "accepted",
        authorityId: ACCEPTED.authorityId,
        ackNo: ACCEPTED.ackNo,
        ackAt: ACCEPTED.ackAt,
      },
    ];
    const { db, recorded } = makeDb([PENDING_STATE, onFile, PENDING_STATE]);
    const service = new ComplianceService(db, makeBooks(recorded));

    const filing = await service.fileDocument(ORG, "sales_invoice", "doc-1", makeAdapter(recorded));

    expect(filing.outcome).toBe("filed");
    expect(recorded.events).not.toContain("submit");
    expect(recorded.events).not.toContain("insert");
  });

  it("stops before the round trip when nothing is owed, so an unreportable document reaches no authority", async () => {
    const notRequired = [{ ...PENDING_STATE[0], status: "not_required" }];
    const { db, recorded } = makeDb([notRequired]);
    const service = new ComplianceService(db, makeBooks(recorded));

    const filing = await service.fileDocument(ORG, "sales_invoice", "doc-1", makeAdapter(recorded));

    expect(filing.outcome).toBe("not-reportable");
    expect(recorded.events).not.toContain("submit");
  });
});
