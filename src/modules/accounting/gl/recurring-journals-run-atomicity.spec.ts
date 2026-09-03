import { RecurringJournalsService } from "./recurring-journals.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";
import {
  accNumberSequences,
  finRecurringJournalTemplates,
  journalEntries,
  journalLines,
} from "../../../db/schema";

type Template = typeof finRecurringJournalTemplates.$inferSelect;

function makeTemplate(overrides: Partial<Template> = {}): Template {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return {
    id: 7,
    orgId: "org-rj",
    name: "Monthly accrual",
    description: null,
    frequency: "MONTHLY",
    nextRunDate: yesterday,
    lastRunDate: null,
    endDate: null,
    isActive: true,
    lines: [
      { accountId: 1, debit: 100, credit: 0 },
      { accountId: 2, debit: 0, credit: 100 },
    ],
    createdBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Template;
}

interface Store {
  /** Every write issued through the transaction handle, in order. */
  inTransaction: string[];
  /** Every write issued through the pooled handle — the shape this spec exists to forbid. */
  outsideTransaction: string[];
  committed: string[][];
}

function label(table: unknown): string {
  if (table === finRecurringJournalTemplates) return "advance-template";
  if (table === journalEntries) return "insert-entry";
  if (table === journalLines) return "insert-lines";
  if (table === accNumberSequences) return "next-sequence";
  return "unknown";
}

function makeDb(
  templates: Template[],
  options: { claimMatches?: boolean; failOnLines?: boolean } = {},
): { db: Db; store: Store } {
  const store: Store = { inTransaction: [], outsideTransaction: [], committed: [] };
  const claimMatches = options.claimMatches ?? true;

  const makeTx = (log: string[]) => ({
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          const result = claimMatches ? [{ id: 7 }] : [];
          const record = () => {
            log.push(label(table));
          };
          return {
            returning: () => {
              record();
              return Promise.resolve(result);
            },
            then: (resolve: (value: unknown[]) => unknown) => {
              record();
              return Promise.resolve(result).then(resolve);
            },
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: () => {
        log.push(label(table));
        if (options.failOnLines && table === journalLines)
          return Promise.reject(new Error("journal_lines insert failed"));
        const rows = [{ id: 11, entryNumber: "JE-202609-00001", next: 2, padding: 5 }];
        return {
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve(rows) }),
          returning: () => Promise.resolve(rows),
          then: (resolve: (value: typeof rows) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    }),
  });

  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(templates) }) }),
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          store.outsideTransaction.push(label(table));
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

function makeService(db: Db): RecurringJournalsService {
  const audit = { log: jest.fn() } as unknown as AuditService;
  return new RecurringJournalsService(db, audit);
}

describe("ticket 21 box 3 / R-7c — the recurring journal spawn and its template advance are one transaction", () => {
  it("advances the template through the transaction handle, never through the pooled one", async () => {
    const { db, store } = makeDb([makeTemplate()]);

    const result = await makeService(db).runDueTemplates();

    expect(result).toEqual({ processed: 1, errors: 0 });
    expect(store.outsideTransaction).toEqual([]);
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]).toEqual([
      "advance-template",
      "next-sequence",
      "insert-entry",
      "insert-lines",
    ]);
  });

  it("claims the template before writing the entry, so a lost claim spawns nothing", async () => {
    const { db, store } = makeDb([makeTemplate()], { claimMatches: false });

    const result = await makeService(db).runDueTemplates();

    expect(result).toEqual({ processed: 0, errors: 0 });
    expect(store.inTransaction).toEqual(["advance-template"]);
    expect(store.inTransaction).not.toContain("insert-entry");
  });

  it("rolls the advance back with the entry when the entry write fails", async () => {
    const { db, store } = makeDb([makeTemplate()], { failOnLines: true });

    const result = await makeService(db).runDueTemplates();

    expect(result).toEqual({ processed: 0, errors: 1 });
    expect(store.committed).toEqual([]);
    expect(store.outsideTransaction).toEqual([]);
  });

  it("runNow puts its entry and its advance in the same transaction", async () => {
    const template = makeTemplate();
    const { db, store } = makeDb([template]);
    const selectDb = {
      ...db,
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([template]) }) }) }),
    } as unknown as Db;

    await makeService(selectDb).runNow("org-rj", "user-1", 7);

    expect(store.outsideTransaction).toEqual([]);
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]).toEqual([
      "next-sequence",
      "insert-entry",
      "insert-lines",
      "advance-template",
    ]);
  });
});
