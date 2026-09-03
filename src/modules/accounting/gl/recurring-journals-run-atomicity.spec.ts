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

interface EntryRow {
  orgId: string;
  entryNumber: string;
  sourceId: string;
}

interface LineRow {
  entryId: number;
  accountId: number;
  orgId: string;
  lineOrder: number;
}

interface Store {
  /** Every write issued through the transaction handle, in order. */
  inTransaction: string[];
  /** Every write issued through the pooled handle — the shape this spec exists to forbid. */
  outsideTransaction: string[];
  committed: string[][];
  /** The rows each multi-row journal-entry INSERT carried. One array per statement. */
  entryBatches: EntryRow[][];
  /** The rows each multi-row journal-line INSERT carried. One array per statement. */
  lineBatches: LineRow[][];
  /** `nextRunDate` of every claim UPDATE, in order — one per distinct frequency in a batch. */
  claimAdvances: string[];
}

function label(table: unknown): string {
  if (table === finRecurringJournalTemplates) return "advance-template";
  if (table === journalEntries) return "insert-entry";
  if (table === journalLines) return "insert-lines";
  if (table === accNumberSequences) return "next-sequence";
  return "unknown";
}

interface DbOptions {
  /** Ids the claim UPDATE reports back. `null` (the default) claims every template. */
  claimed?: number[] | null;
  failOnLines?: boolean;
}

function makeDb(templates: Template[], options: DbOptions = {}): { db: Db; store: Store } {
  const store: Store = {
    inTransaction: [],
    outsideTransaction: [],
    committed: [],
    entryBatches: [],
    lineBatches: [],
    claimAdvances: [],
  };
  const claimedIds =
    options.claimed === undefined ? templates.map((t) => t.id) : (options.claimed ?? []);

  const makeTx = (log: string[]) => ({
    update: (table: unknown) => ({
      set: (values: { nextRunDate?: string }) => ({
        where: () => {
          const record = () => {
            log.push(label(table));
            if (values.nextRunDate !== undefined) store.claimAdvances.push(values.nextRunDate);
          };
          const result = claimedIds.map((id) => ({ id }));
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
      values: (rows: unknown) => {
        log.push(label(table));
        if (options.failOnLines && table === journalLines)
          return Promise.reject(new Error("journal_lines insert failed"));

        if (table === journalEntries) {
          // `runNow` still posts one entry and passes a single object; the batch
          // path passes an array. Both reach the same INSERT.
          const entryRows = (Array.isArray(rows) ? rows : [rows]) as EntryRow[];
          store.entryBatches.push(entryRows);
          const returned = entryRows.map((row, index) => ({
            id: 100 + index,
            sourceId: row.sourceId,
            entryNumber: row.entryNumber,
          }));
          return {
            returning: () => Promise.resolve(returned),
            then: (resolve: (value: typeof returned) => unknown) =>
              Promise.resolve(returned).then(resolve),
          };
        }

        if (table === journalLines) {
          store.lineBatches.push(rows as LineRow[]);
          return {
            returning: () => Promise.resolve([]),
            then: (resolve: (value: never[]) => unknown) => Promise.resolve([]).then(resolve),
          };
        }

        // accNumberSequences: the counter moves by the size of the block the caller
        // reserved, and the upsert reports the value AFTER the bump. Modelling the
        // fresh-insert branch (`nextNumber: count + 1`) is what makes the first
        // reserved number 1, exactly as an empty sequence row would.
        const seq = rows as { nextNumber: number };
        const returned = [{ next: seq.nextNumber, padding: 5 }];
        return {
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve(returned) }),
          returning: () => Promise.resolve(returned),
          then: (resolve: (value: typeof returned) => unknown) =>
            Promise.resolve(returned).then(resolve),
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
    const { db, store } = makeDb([makeTemplate()], { claimed: [] });

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

/**
 * PRD-C069/C072 — the database-call count of the sweep, pinned.
 *
 * The claim and the post used to be four statements and a transaction PER due
 * template, behind a `claimAndMaterialize(tmpl, …)` call the N+1 detector could
 * not see: `check:db-call-count` reported the file as a stale ACTIONABLE verdict
 * while the loop was still there. These assertions are on the STATEMENT COUNT,
 * not on the arrangement of the code, so the same regression cannot come back
 * under another private-method name.
 */
describe("PRD-C069 — the due sweep costs statements per org, not per template", () => {
  it("posts every due template of one org in a single four-statement transaction", async () => {
    const templates = [1, 2, 3, 4, 5].map((id) => makeTemplate({ id, name: `Template ${id}` }));
    const { db, store } = makeDb(templates);

    const result = await makeService(db).runDueTemplates();

    expect(result).toEqual({ processed: 5, errors: 0 });
    expect(store.committed).toHaveLength(1);
    expect(store.committed[0]).toEqual([
      "advance-template",
      "next-sequence",
      "insert-entry",
      "insert-lines",
    ]);
    expect(store.entryBatches).toHaveLength(1);
    expect(store.entryBatches[0]).toHaveLength(5);
    expect(store.lineBatches).toHaveLength(1);
    expect(store.lineBatches[0]).toHaveLength(10);
  });

  it("claims one UPDATE per distinct frequency, not one per template", async () => {
    const templates = [
      makeTemplate({ id: 1, frequency: "MONTHLY" }),
      makeTemplate({ id: 2, frequency: "MONTHLY" }),
      makeTemplate({ id: 3, frequency: "WEEKLY" }),
      makeTemplate({ id: 4, frequency: "WEEKLY" }),
      makeTemplate({ id: 5, frequency: "WEEKLY" }),
    ];
    const { db, store } = makeDb(templates);

    const result = await makeService(db).runDueTemplates();

    expect(result).toEqual({ processed: 5, errors: 0 });
    expect(store.committed[0]?.filter((s) => s === "advance-template")).toHaveLength(2);
    // The two SET clauses differ, which is the whole reason the claim groups on frequency.
    expect(new Set(store.claimAdvances).size).toBe(2);
  });

  it("opens one transaction per org, so a batch never spans two tenants", async () => {
    const templates = [
      makeTemplate({ id: 1, orgId: "org-a" }),
      makeTemplate({ id: 2, orgId: "org-a" }),
      makeTemplate({ id: 3, orgId: "org-b" }),
    ];
    const { db, store } = makeDb(templates);

    const result = await makeService(db).runDueTemplates();

    expect(result).toEqual({ processed: 3, errors: 0 });
    expect(store.committed).toHaveLength(2);
    expect(store.entryBatches.map((batch) => batch[0]?.orgId)).toEqual(["org-a", "org-b"]);
    expect(store.entryBatches.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it("reserves one consecutive block of entry numbers instead of one number per entry", async () => {
    const templates = [1, 2, 3].map((id) => makeTemplate({ id }));
    const { db, store } = makeDb(templates);

    await makeService(db).runDueTemplates();

    expect(store.committed[0]?.filter((s) => s === "next-sequence")).toHaveLength(1);
    const period = new Date().toISOString().slice(0, 7).replace("-", "");
    expect(store.entryBatches[0]?.map((row) => row.entryNumber)).toEqual([
      `JE-${period}-00001`,
      `JE-${period}-00002`,
      `JE-${period}-00003`,
    ]);
  });

  it("binds each entry's lines by sourceId, so an out-of-order RETURNING cannot cross them", async () => {
    const templates = [
      makeTemplate({ id: 1, lines: [{ accountId: 11, debit: 5, credit: 0 }, { accountId: 12, debit: 0, credit: 5 }] as unknown as Template["lines"] }),
      makeTemplate({ id: 2, lines: [{ accountId: 21, debit: 7, credit: 0 }, { accountId: 22, debit: 0, credit: 7 }] as unknown as Template["lines"] }),
    ];
    const { db, store } = makeDb(templates);

    await makeService(db).runDueTemplates();

    const entries = store.entryBatches[0] ?? [];
    const lines = store.lineBatches[0] ?? [];
    const idBySource = new Map(entries.map((row, index) => [row.sourceId, 100 + index]));
    for (const line of lines) {
      const owner = line.accountId < 20 ? "1" : "2";
      expect(line.entryId).toBe(idBySource.get(owner));
    }
  });

  it("counts an unbalanced template as an error and still posts the ones around it", async () => {
    const templates = [
      makeTemplate({ id: 1 }),
      makeTemplate({
        id: 2,
        lines: [{ accountId: 3, debit: 100, credit: 0 }] as unknown as Template["lines"],
      }),
      makeTemplate({ id: 3 }),
    ];
    const { db, store } = makeDb(templates);

    const result = await makeService(db).runDueTemplates();

    expect(result).toEqual({ processed: 2, errors: 1 });
    expect(store.entryBatches[0]?.map((row) => row.sourceId)).toEqual(["1", "3"]);
  });

  it("drops a template another sweep claimed first rather than posting it", async () => {
    const templates = [1, 2, 3].map((id) => makeTemplate({ id }));
    const { db, store } = makeDb(templates, { claimed: [1, 3] });

    const result = await makeService(db).runDueTemplates();

    expect(result).toEqual({ processed: 2, errors: 0 });
    expect(store.entryBatches[0]?.map((row) => row.sourceId)).toEqual(["1", "3"]);
  });
});
