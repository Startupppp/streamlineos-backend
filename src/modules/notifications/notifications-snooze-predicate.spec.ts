import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import { NotificationsReadService } from "./notifications-read.service";
import { NotificationsLifecycleService } from "./notifications-lifecycle.service";
import { NotificationVisibilityRegistry } from "./notification-visibility.registry";
import { listSchema, type ListInput } from "./dto/notification.schemas";

const dialect = new PgDialect();

const COLUMN_TO_FIELD: Record<string, string> = {
  '"notifications"."id"': "id",
  '"notifications"."org_id"': "orgId",
  '"notifications"."membership_id"': "membershipId",
  '"notifications"."category"': "category",
  '"notifications"."priority"': "priority",
  '"notifications"."source_module"': "sourceModule",
  '"notifications"."event_key"': "eventKey",
  '"notifications"."title"': "title",
  '"notifications"."message"': "message",
  '"notifications"."is_read"': "isRead",
  '"notifications"."pinned"': "pinned",
  '"notifications"."archived_at"': "archivedAt",
  '"notifications"."snoozed_until"': "snoozedUntil",
  '"notifications"."deleted_at"': "deletedAt",
  '"notifications"."created_at"': "createdAt",
};

type Scalar = string | number | boolean | Date | null;
type NotificationRow = Record<string, Scalar | Record<string, unknown>>;

function comparable(value: unknown): number | string | boolean | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

function asEpoch(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Drizzle binds a `timestamp with time zone` parameter as an ISO string while the
 * fixture holds a `Date`, so a raw comparison of the two is NaN — silently false for
 * every row and every section, which reads exactly like a predicate that is working.
 */
function normalize(
  actual: unknown,
  expected: unknown,
): [number | string | boolean | null, number | string | boolean | null] {
  if (actual instanceof Date || expected instanceof Date)
    return [asEpoch(actual), asEpoch(expected)];
  return [comparable(actual), comparable(expected)];
}

/**
 * A predicate evaluator over the WHERE drizzle actually compiles, so "the snoozed row
 * is absent" is a result of the SQL rather than a restatement of the source text. A
 * chain mock that returns every fixture regardless of the condition would pass before
 * and after the fix and measure nothing.
 */
class WhereEvaluator {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly params: readonly unknown[],
    private readonly row: NotificationRow,
  ) {}

  evaluate(): boolean {
    const value = this.parseOr();
    this.skipSpaces();
    if (this.index !== this.text.length)
      throw new Error(`unparsed WHERE remainder: ${this.text.slice(this.index)}`);
    return value;
  }

  private skipSpaces() {
    while (this.text[this.index] === " ") this.index += 1;
  }

  private consume(token: string): boolean {
    this.skipSpaces();
    if (!this.text.startsWith(token, this.index)) return false;
    this.index += token.length;
    return true;
  }

  private parseOr(): boolean {
    let result = this.parseAnd();
    while (this.consume("or ")) result = this.parseAnd() || result;
    return result;
  }

  private parseAnd(): boolean {
    let result = this.parseFactor();
    while (this.consume("and ")) result = this.parseFactor() && result;
    return result;
  }

  private parseFactor(): boolean {
    if (this.consume("(")) {
      const inner = this.parseOr();
      if (!this.consume(")")) throw new Error("unbalanced parenthesis in WHERE");
      return inner;
    }
    return this.parseLeaf();
  }

  private parseColumn(): string {
    this.skipSpaces();
    const match = /^"[a-z_]+"\."[a-z_]+"/.exec(this.text.slice(this.index));
    if (!match) throw new Error(`expected a column at: ${this.text.slice(this.index, this.index + 40)}`);
    this.index += match[0].length;
    const field = COLUMN_TO_FIELD[match[0]];
    if (!field) throw new Error(`unmapped column ${match[0]}`);
    return field;
  }

  private parseOperand(): unknown {
    this.skipSpaces();
    const match = /^\$(\d+)/.exec(this.text.slice(this.index));
    if (!match?.[1]) throw new Error(`expected a bind parameter at: ${this.text.slice(this.index, this.index + 40)}`);
    this.index += match[0].length;
    return this.params[Number(match[1]) - 1];
  }

  private parseOperandList(): unknown[] {
    const values: unknown[] = [];
    do values.push(this.parseOperand());
    while (this.consume(","));
    if (!this.consume(")")) throw new Error("unterminated IN list");
    return values;
  }

  private parseLeaf(): boolean {
    const field = this.parseColumn();
    const actual = this.row[field] ?? null;
    if (this.consume("is not null")) return actual !== null;
    if (this.consume("is null")) return actual === null;
    if (this.consume("in (")) {
      const list = this.parseOperandList().map(comparable);
      return list.includes(comparable(actual));
    }
    if (this.consume("ilike")) {
      const pattern = this.parseOperand();
      if (typeof actual !== "string" || typeof pattern !== "string") return false;
      return actual.toLowerCase().includes(pattern.replaceAll("%", "").toLowerCase());
    }
    for (const operator of ["<=", ">=", "<>", "=", "<", ">"] as const) {
      if (!this.consume(operator)) continue;
      const [left, expected] = normalize(actual, this.parseOperand());
      if (left === null || expected === null) return false;
      if (operator === "=") return left === expected;
      if (operator === "<>") return left !== expected;
      if (operator === "<=") return left <= expected;
      if (operator === ">=") return left >= expected;
      if (operator === "<") return left < expected;
      return left > expected;
    }
    throw new Error(`unsupported operator at: ${this.text.slice(this.index, this.index + 40)}`);
  }
}

interface RecordedWhere {
  table: string;
  sql: string;
  params: readonly unknown[];
}

const MEMBERSHIP_ID = 7;

function makeReadDb(rows: NotificationRow[]): { db: Db; recorded: RecordedWhere[] } {
  const recorded: RecordedWhere[] = [];

  const chain = (result: unknown[]): object =>
    Object.assign(Promise.resolve(result), {
      orderBy: () => chain(result),
      limit: (take: number) => chain(result.slice(0, take)),
    });

  const makeFrom = (table: string, fields: Record<string, unknown>): object => {
    const self: Record<string, unknown> = {
      leftJoin: () => makeFrom(table, fields),
      innerJoin: () => makeFrom(table, fields),
      where: (condition: SQL) => {
        const query = dialect.sqlToQuery(condition);
        recorded.push({ table, sql: query.sql, params: query.params });
        if (table !== "notifications")
          return chain([{ membershipId: MEMBERSHIP_ID, lastReadId: null }]);
        const matched = rows.filter((row) =>
          new WhereEvaluator(query.sql, query.params, row).evaluate(),
        );
        if ("count" in fields) return chain([{ count: matched.length }]);
        return chain(matched);
      },
    };
    return self;
  };

  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: PgTable) => makeFrom(getTableName(table), fields),
    }),
  } as unknown as Db;
  return { db, recorded };
}

const ORG = "org-owner";
const OTHER_ORG = "org-attacker";
const NOW = new Date("2026-09-12T12:00:00.000Z");
const HOUR_MS = 3_600_000;

function notification(overrides: Partial<NotificationRow> & { id: number }): NotificationRow {
  return {
    orgId: ORG,
    membershipId: MEMBERSHIP_ID,
    userId: "user-owner",
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    sourceModule: null,
    eventKey: null,
    entityType: null,
    entityId: null,
    reason: null,
    title: "title",
    message: "message",
    link: null,
    isRead: false,
    pinned: false,
    channel: "IN_APP",
    metadata: null,
    archivedAt: null,
    snoozedUntil: null,
    deletedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function makeReadService(rows: NotificationRow[]) {
  const { db, recorded } = makeReadDb(rows);
  const cache = {
    cachedVersioned: (_ns: string, _key: string, load: () => unknown) => Promise.resolve(load()),
  } as never;
  return {
    service: new NotificationsReadService(db, cache, new NotificationVisibilityRegistry()),
    recorded,
  };
}

function filters(over: Partial<ListInput> = {}): ListInput {
  return listSchema.parse({ ...over });
}

async function idsIn(rows: NotificationRow[], section: ListInput["section"]): Promise<number[]> {
  const { service } = makeReadService(rows);
  const page = await service.list(ORG, "user-owner", filters({ section }));
  return page.data.map((row) => row.id);
}

const FUTURE = notification({ id: 3, snoozedUntil: new Date(NOW.getTime() + HOUR_MS) });
const PAST = notification({ id: 2, snoozedUntil: new Date(NOW.getTime() - HOUR_MS) });
const NEVER_SNOOZED = notification({ id: 1, snoozedUntil: null });

describe("notifications snooze suppression", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it("UNREAD hides a notification snoozed into the future and keeps the rest", async () => {
    expect(await idsIn([FUTURE, PAST, NEVER_SNOOZED], "UNREAD")).toEqual([2, 1]);
  });

  it("ALL, MENTIONS and every other active section hide it too", async () => {
    const mention = notification({
      id: 4,
      eventKey: "chat.message.mention",
      snoozedUntil: new Date(NOW.getTime() + HOUR_MS),
    });
    const rows = [mention, FUTURE, PAST, NEVER_SNOOZED];
    expect(await idsIn(rows, "ALL")).toEqual([2, 1]);
    expect(await idsIn(rows, "MENTIONS")).toEqual([]);
    expect(await idsIn(rows, "READ")).toEqual([]);
    expect(await idsIn(rows, "SYSTEM")).toEqual([2, 1]);
  });

  it("PINNED hides it as well — a pinned row is still an active-inbox row", async () => {
    const pinnedSnoozed = notification({
      id: 5,
      pinned: true,
      snoozedUntil: new Date(NOW.getTime() + HOUR_MS),
    });
    const pinnedVisible = notification({ id: 4, pinned: true });
    expect(await idsIn([pinnedSnoozed, pinnedVisible], "PINNED")).toEqual([4]);
  });

  it("ARCHIVED still returns a snoozed row — archiving must not make it unfindable", async () => {
    const archivedSnoozed = notification({
      id: 6,
      archivedAt: NOW,
      snoozedUntil: new Date(NOW.getTime() + HOUR_MS),
    });
    expect(await idsIn([archivedSnoozed], "ARCHIVED")).toEqual([6]);
  });

  it("the unread count agrees with the list — the badge does not keep counting a snoozed row", async () => {
    const rows = [FUTURE, PAST, NEVER_SNOOZED];
    const { service } = makeReadService(rows);
    const list = await service.list(ORG, "user-owner", filters({ section: "UNREAD" }));
    const badge = await service.unreadCount(ORG, "user-owner");
    expect(badge).toEqual({ count: 2 });
    expect(badge.count).toBe(list.data.length);
  });

  it("snooze, refetch, refetch after the deadline: gone, gone, back — and still unread", async () => {
    const target = notification({ id: 9 });
    const lifecycleDb = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: MEMBERSHIP_ID }]) }) }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({
            returning: () => {
              Object.assign(target, patch);
              return Promise.resolve([{ id: target.id }]);
            },
          }),
        }),
      }),
    } as unknown as Db;
    const invalidateNamespace = jest.fn().mockResolvedValue(undefined);
    const emit = jest.fn();
    const lifecycle = new NotificationsLifecycleService(
      lifecycleDb,
      { invalidateNamespace } as never,
      { emit } as never,
    );

    const deadline = new Date(NOW.getTime() + HOUR_MS);
    expect(await idsIn([target], "UNREAD")).toEqual([9]);

    await lifecycle.snooze(ORG, "user-owner", 9, { snoozedUntil: deadline.toISOString() });
    expect(invalidateNamespace).toHaveBeenCalledWith(`notifications:user-owner:${ORG}`);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-owner", orgId: ORG, type: "count_changed" }),
    );
    expect(target.isRead).toBe(false);
    expect(target.archivedAt).toBeNull();
    expect(target.deletedAt).toBeNull();

    expect(await idsIn([target], "UNREAD")).toEqual([]);

    jest.setSystemTime(new Date(deadline.getTime() + 1000));
    expect(await idsIn([target], "UNREAD")).toEqual([9]);
    expect(target.isRead).toBe(false);
  });

  it("the suppression is ANDed with the tenant and recipient scope, never ORed", async () => {
    const foreign = notification({ id: 11, orgId: OTHER_ORG, membershipId: 99 });
    const foreignSnoozed = notification({
      id: 12,
      orgId: OTHER_ORG,
      membershipId: 99,
      snoozedUntil: new Date(NOW.getTime() - HOUR_MS),
    });
    const { service, recorded } = makeReadService([foreignSnoozed, foreign, NEVER_SNOOZED]);

    const page = await service.list(ORG, "user-owner", filters({ section: "UNREAD" }));

    expect(page.data.map((row) => row.id)).toEqual([1]);
    const where = recorded.find((entry) => entry.table === "notifications");
    expect(where?.sql).toContain(
      '("notifications"."snoozed_until" is null or "notifications"."snoozed_until" <= $',
    );
    expect(where?.sql).toContain('"notifications"."org_id" = $');
    expect(where?.sql).not.toMatch(/"notifications"\."org_id" = \$\d+ or /);
  });
});
