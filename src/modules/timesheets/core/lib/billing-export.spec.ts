import { PgDialect } from "drizzle-orm/pg-core";
import { timesheets, timesheetExports } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import {
  BILLING_EXPORT_CHUNK,
  createInvoiceDraft,
  exportBilling,
} from "./billing-export";

const dialect = new PgDialect();
const ORG = "org-1";
const PERIOD = { startDate: "2026-08-01", endDate: "2026-08-31" };

const USER = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
  principal: { kind: "human-session", membershipId: 1 },
} as unknown as CurrentUserContext;

interface Row {
  id: number;
  orgId: string;
  projectId: number | null;
  ticketId: number | null;
  date: string;
  hours: string;
  description: string | null;
  isBillable: boolean;
  billRate: string | null;
  currency: string | null;
  invoicingStatus: string;
  status: string;
}

interface Query {
  sql: string;
  params: unknown[];
}

function render(fragment: unknown): Query {
  return dialect.sqlToQuery(
    fragment as Parameters<PgDialect["sqlToQuery"]>[0],
  );
}

function bound(q: Query, column: string, op: "=" | ">"): unknown {
  const m = new RegExp(`"timesheets"\\."${column}" ${op} \\$(\\d+)`).exec(
    q.sql,
  );
  return m ? q.params[Number(m[1]) - 1] : undefined;
}

function boundIds(q: Query): number[] {
  const m = /"timesheets"\."id" in \(([^)]*)\)/.exec(q.sql);
  if (!m?.[1]) return [];
  return m[1]
    .split(",")
    .map((p) => q.params[Number(p.trim().slice(1)) - 1] as number);
}

function rows(count: number, firstId: number, invoicingStatus = "UNINVOICED"): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i * 7,
    orgId: ORG,
    projectId: 3,
    ticketId: null,
    date: PERIOD.startDate,
    hours: "1.50",
    description: null,
    isBillable: true,
    billRate: "100.00",
    currency: "USD",
    invoicingStatus,
    status: "APPROVED",
  })).reverse();
}

interface StoredExport {
  id: number;
  entryCount: number;
  totalHours: string;
  snapshot: unknown;
}

function fakeDb(table: Row[], stored: StoredExport | null = null) {
  const reads: { afterId: unknown; limit: number; orderBy: string }[] = [];
  const flips: number[][] = [];
  const inserted: Record<string, unknown>[] = [];
  const maxReads = Math.ceil(table.length / BILLING_EXPORT_CHUNK) + 2;

  const readPeriod = () => {
    let where: unknown;
    let orderBy: unknown[] = [];
    const chain = {
      from(t: unknown) {
        if (t !== timesheets)
          throw new Error("the export transaction read something other than timesheets");
        return chain;
      },
      where(w: unknown) {
        where = w;
        return chain;
      },
      orderBy(...cols: unknown[]) {
        orderBy = cols;
        return chain;
      },
      async limit(n: number) {
        if (reads.length >= maxReads)
          throw new Error("the keyset loop did not terminate");
        const q = render(where);
        const afterId = bound(q, "id", ">") as number | undefined;
        const status = bound(q, "invoicing_status", "=");
        reads.push({
          afterId,
          limit: n,
          orderBy: orderBy.map((c) => render(c).sql).join(", "),
        });
        return table
          .filter(
            (r) =>
              (afterId === undefined || r.id > afterId) &&
              (status === undefined || r.invoicingStatus === status),
          )
          .sort((a, b) => a.id - b.id)
          .slice(0, n)
          .map((r) => ({ ...r }));
      },
    };
    return chain;
  };

  const tx = {
    select: () => readPeriod(),
    update(t: unknown) {
      if (t !== timesheets) throw new Error("flipped something other than timesheets");
      return {
        set: (patch: { invoicingStatus: string }) => ({
          async where(w: unknown) {
            const q = render(w);
            if (bound(q, "org_id", "=") !== ORG)
              throw new Error("the flip is not tenant-scoped");
            const ids = boundIds(q);
            flips.push(ids);
            const flipped = new Set(ids);
            for (const r of table)
              if (flipped.has(r.id)) r.invoicingStatus = patch.invoicingStatus;
          },
        }),
      };
    },
    insert(t: unknown) {
      if (t !== timesheetExports)
        throw new Error("inserted something other than timesheet_exports");
      return {
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: async () => [{ id: 500 + inserted.length }] };
        },
      };
    },
  };

  const db = {
    select: () => ({
      from(t: unknown) {
        if (t !== timesheetExports)
          throw new Error("period read outside the export transaction");
        return {
          where: () => ({ limit: async () => (stored ? [stored] : []) }),
        };
      },
    }),
    transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    deps: {
      db: db as unknown as Db,
      audit: audit as unknown as TimesheetsAuditService,
    },
    reads,
    flips,
    inserted,
    audit,
    transaction: db.transaction,
  };
}

const byId = (a: number, b: number) => a - b;
const snapshotIds = (row: Record<string, unknown> | undefined) =>
  (row?.snapshot as { id: number }[]).map((e) => e.id);

const readsFor = (n: number) => Math.floor(n / BILLING_EXPORT_CHUNK) + 1;

const SPANS = [
  ["three chunks, the last one short", BILLING_EXPORT_CHUNK * 2 + 1],
  ["an exact multiple of the chunk", BILLING_EXPORT_CHUNK * 2],
] as const;

describe("createInvoiceDraft over a period longer than one chunk", () => {
  it.each(SPANS)(
    "%s: one export row, and every uninvoiced entry flipped exactly once",
    async (_span, n) => {
      const uninvoiced = rows(n, 1_000);
      const alreadyInvoiced = rows(40, 1_003, "INVOICED");
      const fake = fakeDb([...uninvoiced, ...alreadyInvoiced]);

      const result = await createInvoiceDraft(fake.deps, USER, PERIOD);

      const expectedIds = uninvoiced.map((r) => r.id).sort(byId);
      expect(fake.reads).toHaveLength(readsFor(n));
      expect(fake.reads.every((r) => r.limit === BILLING_EXPORT_CHUNK)).toBe(true);
      expect(fake.reads.every((r) => r.orderBy === '"timesheets"."id" asc')).toBe(true);

      expect(fake.flips.length).toBeGreaterThan(1);
      expect(fake.flips.every((ids) => ids.length <= BILLING_EXPORT_CHUNK)).toBe(true);
      expect(fake.flips.flat().sort(byId)).toEqual(expectedIds);
      expect(uninvoiced.every((r) => r.invoicingStatus === "INVOICE_DRAFTED")).toBe(true);
      expect(alreadyInvoiced.every((r) => r.invoicingStatus === "INVOICED")).toBe(true);

      expect(fake.transaction).toHaveBeenCalledTimes(1);
      expect(fake.inserted).toHaveLength(1);
      expect(fake.inserted[0]).toMatchObject({
        exportType: "INVOICE_DRAFT",
        entryCount: n,
      });
      expect(snapshotIds(fake.inserted[0])).toEqual(expectedIds);
      expect(fake.audit.record).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ exportId: 501, entryCount: n, amount: n * 150 });
    },
  );
});

describe("exportBilling over a period longer than one chunk", () => {
  it.each(SPANS)(
    "%s: one export row whose snapshot holds every entry once",
    async (_span, n) => {
      const entries = [...rows(n - 40, 1_000), ...rows(40, 1_003, "INVOICED")];
      const fake = fakeDb(entries);

      const result = await exportBilling(fake.deps, USER, {
        ...PERIOD,
        format: "CSV",
        idempotencyKey: "first-attempt",
      });

      const expectedIds = entries.map((r) => r.id).sort(byId);
      expect(fake.reads).toHaveLength(readsFor(n));
      expect(fake.transaction).toHaveBeenCalledTimes(1);
      expect(fake.inserted).toHaveLength(1);
      expect(fake.inserted[0]).toMatchObject({
        exportType: "BILLING",
        entryCount: n,
        totalHours: String(n * 1.5),
      });
      expect(snapshotIds(fake.inserted[0])).toEqual(expectedIds);
      expect(fake.flips).toEqual([]);
      expect(result).toEqual({
        exportId: 501,
        entryCount: n,
        totalHours: n * 1.5,
        totalAmount: n * 150,
        fileName: `billing-export_${PERIOD.startDate}_${PERIOD.endDate}.csv`,
        csv: expect.any(String),
      });
    },
  );

  it("a replayed idempotency key returns the stored export without reading the period", async () => {
    const fake = fakeDb(rows(5, 1_000), {
      id: 42,
      entryCount: 2,
      totalHours: "3.00",
      snapshot: [{ computedAmount: 150 }, { computedAmount: 150.5 }],
    });

    const result = await exportBilling(fake.deps, USER, {
      ...PERIOD,
      format: "CSV",
      idempotencyKey: "retry",
    });

    expect(result).toEqual({
      exportId: 42,
      entryCount: 2,
      totalHours: 3,
      totalAmount: 300.5,
      duplicate: true,
      csv: expect.any(String),
    });
    expect(fake.transaction).not.toHaveBeenCalled();
    expect(fake.reads).toEqual([]);
    expect(fake.inserted).toEqual([]);
  });
});
