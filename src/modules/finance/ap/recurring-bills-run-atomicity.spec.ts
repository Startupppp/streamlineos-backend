import { RecurringBillsService } from "./recurring-bills.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { finRecurringBillTemplates, purchaseBills, purchaseBillItems } from "../../../db/schema";

type Template = typeof finRecurringBillTemplates.$inferSelect;

const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const LAST_WEEK = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: 1,
    orgId: "org-a",
    name: "Monthly hosting",
    vendorId: 5,
    frequency: "MONTHLY",
    nextRunDate: YESTERDAY,
    lastRunDate: null,
    endDate: null,
    isActive: true,
    payload: {
      vendorId: 5,
      billDate: YESTERDAY,
      reverseCharge: false,
      discount: 0,
      expenseAccountCode: "5100",
      items: [{ description: "Hosting", quantity: 1, rate: 1000, gstRate: 18 }],
    },
    createdBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Template;
}

interface Store {
  /** Deactivation statements issued on the pooled handle, one entry per statement. */
  pooledUpdates: number;
  /** Writes issued through a transaction handle that COMMITTED, grouped per transaction. */
  committed: string[][];
  inTransaction: string[];
}

function label(table: unknown): string {
  if (table === finRecurringBillTemplates) return "advance-template";
  if (table === purchaseBills) return "insert-bill";
  if (table === purchaseBillItems) return "insert-items";
  return "unknown";
}

function makeDb(
  templates: Template[],
  options: { claimMatches?: boolean; failOnItems?: boolean } = {},
): { db: Db; store: Store } {
  const store: Store = { pooledUpdates: 0, committed: [], inTransaction: [] };
  const claimMatches = options.claimMatches ?? true;

  const makeTx = (log: string[]) => ({
    select: () => ({ from: () => ({ where: () => Promise.resolve([{ count: 3 }]) }) }),
    update: (table: unknown) => ({
      set: () => ({
        where: () => ({
          returning: () => {
            log.push(label(table));
            return Promise.resolve(claimMatches ? [{ id: 1 }] : []);
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: () => {
        log.push(label(table));
        if (options.failOnItems && table === purchaseBillItems)
          return Promise.reject(new Error("purchase_bill_items insert failed"));
        const rows = [{ id: 99, billNumber: "BILL-2026-0004" }];
        return {
          returning: () => Promise.resolve(rows),
          then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    }),
  });

  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(templates) }) }) }),
    update: () => ({
      set: () => ({
        where: () => {
          store.pooledUpdates++;
          return Promise.resolve([]);
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const log: string[] = [];
      try {
        const result = await fn(makeTx(log));
        store.inTransaction.push(...log);
        store.committed.push(log);
        return result;
      } catch (err) {
        store.inTransaction.push(...log);
        throw err;
      }
    },
  } as unknown as Db;

  return { db, store };
}

function makeService(db: Db, dispatch: { emit: jest.Mock }): RecurringBillsService {
  return new RecurringBillsService(
    db,
    { log: jest.fn() } as unknown as AuditService,
    { invalidate: jest.fn().mockResolvedValue(undefined) } as unknown as CacheService,
    dispatch as unknown as NotificationDispatchService,
  );
}

describe("ticket 21 box 3 / R-7c — the recurring bill spawn and its template advance are one transaction", () => {
  it("advances the template inside the spawning transaction, never on the pooled handle", async () => {
    const { db, store } = makeDb([makeTemplate()]);
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };

    await makeService(db, dispatch).runDueRecurringBills();

    expect(store.pooledUpdates).toBe(0);
    expect(store.committed).toEqual([["advance-template", "insert-bill", "insert-items"]]);
    expect(dispatch.emit).toHaveBeenCalledTimes(1);
  });

  it("claims the template before the bill is written, so a lost claim spawns and notifies nothing", async () => {
    const { db, store } = makeDb([makeTemplate()], { claimMatches: false });
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };

    await makeService(db, dispatch).runDueRecurringBills();

    expect(store.inTransaction).toEqual(["advance-template"]);
    expect(store.inTransaction).not.toContain("insert-bill");
    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  it("rolls the advance back with the bill when the bill write fails", async () => {
    const { db, store } = makeDb([makeTemplate()], { failOnItems: true });
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };

    await makeService(db, dispatch).runDueRecurringBills();

    expect(store.committed).toEqual([]);
    expect(store.pooledUpdates).toBe(0);
    expect(dispatch.emit).not.toHaveBeenCalled();
  });

  it("deactivates expired templates from three organisations in ONE statement, not one per organisation", async () => {
    const expired = [
      makeTemplate({ id: 11, orgId: "org-a", endDate: LAST_WEEK }),
      makeTemplate({ id: 12, orgId: "org-b", endDate: LAST_WEEK }),
      makeTemplate({ id: 13, orgId: "org-c", endDate: LAST_WEEK }),
    ];
    const { db, store } = makeDb(expired);
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };

    await makeService(db, dispatch).runDueRecurringBills();

    expect(store.pooledUpdates).toBe(1);
    expect(store.committed).toEqual([]);
  });
});
