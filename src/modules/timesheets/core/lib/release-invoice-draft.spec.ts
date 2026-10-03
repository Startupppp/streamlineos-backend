import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { timesheets } from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { TimesheetsAuditService } from "../timesheets-audit.service";
import { releaseInvoiceDraft } from "./billing-export";

const dialect = new PgDialect();
const ORG = "org-1";
const OTHER_ORG = "org-2";

const USER = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
  principal: { kind: "human-session", membershipId: 1 },
} as unknown as CurrentUserContext;

interface Row {
  id: number;
  orgId: string;
  invoicingStatus: string;
}

interface Query {
  sql: string;
  params: unknown[];
}

function render(fragment: unknown): Query {
  return dialect.sqlToQuery(fragment as Parameters<PgDialect["sqlToQuery"]>[0]);
}

function bound(q: Query, column: string): unknown {
  const m = new RegExp(`"timesheets"\\."${column}" = \\$(\\d+)`).exec(q.sql);
  return m ? q.params[Number(m[1]) - 1] : undefined;
}

function boundIds(q: Query): number[] {
  const m = /"timesheets"\."id" in \(([^)]*)\)/.exec(q.sql);
  if (!m?.[1]) return [];
  return m[1].split(",").map((p) => q.params[Number(p.trim().slice(1)) - 1] as number);
}

/**
 * `releaseInvoiceDraft` (lib/billing-export.ts) is the fix for entries stuck
 * at `INVOICE_DRAFTED` with no real invoice behind them — `createInvoiceDraft`
 * flips them there as an export snapshot, and nothing else in the timesheets
 * or invoices module ever reversed it before this existed. It is a plain
 * tenant-scoped select + update inside one transaction, not the chunked
 * keyset read `createInvoiceDraft`/`exportBilling` use, so it gets its own
 * fake `tx` rather than reusing `billing-export.spec.ts`'s chunk-shaped one.
 *
 * The fake renders the real `where` SQL and filters `table` by the bound
 * `org_id` and `id`s itself, the same discipline `billing-export.spec.ts`
 * uses for its own tenant assertion — a fake that only ever holds one
 * org's rows cannot tell a filtered read from an unfiltered one, which is
 * exactly the failure mode a decorative tenant-isolation test has.
 */
function fakeDb(table: Row[]) {
  const updatedWhereQueries: Query[] = [];
  let updatedTo: string | undefined;

  const tx = {
    select: () => ({
      from(t: unknown) {
        if (t !== timesheets) throw new Error("read something other than timesheets");
        return {
          where(w: unknown) {
            const q = render(w);
            const orgId = bound(q, "org_id");
            const ids = new Set(boundIds(q));
            const rows = table
              .filter((r) => r.orgId === orgId && ids.has(r.id))
              .map((r) => ({ id: r.id, invoicingStatus: r.invoicingStatus }));
            return {
              async limit(n: number) {
                return rows.slice(0, n);
              },
            };
          },
        };
      },
    }),
    update(t: unknown) {
      if (t !== timesheets) throw new Error("updated something other than timesheets");
      return {
        set: (patch: { invoicingStatus: string }) => {
          updatedTo = patch.invoicingStatus;
          return {
            where: (w: unknown) => {
              const q = render(w);
              updatedWhereQueries.push(q);
              const orgId = bound(q, "org_id");
              const ids = new Set(boundIds(q));
              const released = table.filter((r) => r.orgId === orgId && ids.has(r.id));
              for (const r of released) r.invoicingStatus = patch.invoicingStatus;
              return {
                async returning() {
                  return released.map((r) => ({ id: r.id }));
                },
              };
            },
          };
        },
      };
    },
  };

  const db = {
    transaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    deps: {
      db: db as unknown as Db,
      audit: audit as unknown as TimesheetsAuditService,
    },
    audit,
    transaction: db.transaction,
    updatedWhereQueries,
    updatedTo: () => updatedTo,
    table,
  };
}

describe("releaseInvoiceDraft", () => {
  it("releases a drafted entry back to UNINVOICED and audits it", async () => {
    const fake = fakeDb([{ id: 77, orgId: ORG, invoicingStatus: "INVOICE_DRAFTED" }]);

    const result = await releaseInvoiceDraft(fake.deps, USER, {
      timesheetEntryIds: [77],
    });

    expect(result).toEqual({ releasedEntryIds: [77] });
    expect(fake.updatedTo()).toBe("UNINVOICED");
    expect(fake.table[0].invoicingStatus).toBe("UNINVOICED");
    expect(fake.transaction).toHaveBeenCalledTimes(1);
    expect(fake.audit.record).toHaveBeenCalledTimes(1);
    expect(fake.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG,
        action: "billing.invoice_draft_released",
        after: { releasedEntryIds: [77] },
      }),
    );
  });

  it("refuses an id that does not resolve in the caller's organization — 404, not a silent no-op", async () => {
    const fake = fakeDb([{ id: 4242, orgId: OTHER_ORG, invoicingStatus: "INVOICE_DRAFTED" }]);

    await expect(
      releaseInvoiceDraft(fake.deps, USER, { timesheetEntryIds: [4242] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Never flipped: the read never resolved it in USER's org.
    expect(fake.table[0].invoicingStatus).toBe("INVOICE_DRAFTED");
  });

  it("refuses an entry that is not currently INVOICE_DRAFTED, rather than silently releasing whatever it finds", async () => {
    const fake = fakeDb([{ id: 77, orgId: ORG, invoicingStatus: "UNINVOICED" }]);

    await expect(
      releaseInvoiceDraft(fake.deps, USER, { timesheetEntryIds: [77] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses an entry already fully INVOICED — release is for a stranded draft, not a way to unwind a real invoice", async () => {
    const fake = fakeDb([{ id: 77, orgId: ORG, invoicingStatus: "INVOICED" }]);

    await expect(
      releaseInvoiceDraft(fake.deps, USER, { timesheetEntryIds: [77] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.table[0].invoicingStatus).toBe("INVOICED");
  });
});
