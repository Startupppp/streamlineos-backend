import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { MailMetadataService } from "./mail-metadata.service";

const dialect = new PgDialect();

const ORG = "org-keyset";
const MEMBERSHIP = 77;
const ACCOUNT = 9;

type Row = {
  id: number;
  messageId: string;
  threadId: string | null;
  accountId: number;
  subject: string;
  senderEmail: string;
  senderName: string | null;
  date: Date | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachment: boolean;
  labels: string[] | null;
  folder: string;
  syncedAt: Date;
};

function row(id: number, dateIso: string | null, syncedAt = new Date()): Row {
  return {
    id,
    messageId: `msg-${id}`,
    threadId: null,
    accountId: ACCOUNT,
    subject: `Subject ${id}`,
    senderEmail: "sender@example.com",
    senderName: "Sender",
    date: dateIso === null ? null : new Date(dateIso),
    isRead: false,
    isStarred: false,
    hasAttachment: false,
    labels: null,
    folder: "inbox",
    syncedAt,
  };
}

function makeDb(rows: Row[], searchIds?: Array<{ id: number }>) {
  let capturedWhere: SQL | undefined;
  let capturedOrder: unknown[] = [];
  let capturedLimit = 0;
  const execute = jest.fn().mockResolvedValue(searchIds ?? []);
  const limit = jest.fn().mockImplementation((n: number) => {
    capturedLimit = n;
    return Promise.resolve(rows.slice(0, n));
  });
  const orderBy = jest.fn().mockImplementation((...cols: unknown[]) => {
    capturedOrder = cols;
    return { limit };
  });
  const where = jest.fn().mockImplementation((pred: SQL) => {
    capturedWhere = pred;
    return { orderBy };
  });
  const from = jest.fn().mockReturnValue({ where });
  const db = {
    select: jest.fn().mockReturnValue({ from }),
    execute,
  } as unknown as Db;
  return {
    db,
    execute,
    getWhere: () => capturedWhere,
    getOrder: () => capturedOrder,
    getLimit: () => capturedLimit,
  };
}

function renderWhere(pred: SQL | undefined): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(pred as SQL);
  return { sql, params: [...params] };
}

describe("MailMetadataService.listCached — keyset paging", () => {
  it("orders by (date DESC, id DESC), not date alone", async () => {
    const harness = makeDb([row(3, "2027-01-03T00:00:00.000Z")]);
    const service = new MailMetadataService(harness.db);

    await service.listCached(MEMBERSHIP, ORG, ACCOUNT, "inbox", 10);

    expect(harness.getOrder()).toHaveLength(2);
    const rendered = harness.getOrder().map((c) => dialect.sqlToQuery(c as SQL).sql);
    expect(rendered[0]).toContain("date");
    expect(rendered[0]).toContain("desc");
    expect(rendered[1]).toContain("id");
    expect(rendered[1]).toContain("desc");
  });

  it("asks for limit + 1 and reports a next cursor only when the extra row exists", async () => {
    const three = [
      row(3, "2027-01-03T00:00:00.000Z"),
      row(2, "2027-01-02T00:00:00.000Z"),
      row(1, "2027-01-01T00:00:00.000Z"),
    ];

    const more = makeDb(three);
    const page = await new MailMetadataService(more.db).listCached(MEMBERSHIP, ORG, ACCOUNT, "inbox", 2);
    expect(more.getLimit()).toBe(3);
    expect(page.messages).toHaveLength(2);
    expect(page.nextCursor).toEqual({ d: "2027-01-02T00:00:00.000Z", i: 2 });

    const exact = makeDb(three.slice(0, 2));
    const last = await new MailMetadataService(exact.db).listCached(MEMBERSHIP, ORG, ACCOUNT, "inbox", 2);
    expect(last.messages).toHaveLength(2);
    expect(last.nextCursor).toBeNull();
  });

  it("resumes with a row comparison against (date, id), so a shared timestamp cannot repeat or skip", async () => {
    const harness = makeDb([]);
    await new MailMetadataService(harness.db).listCached(
      MEMBERSHIP, ORG, ACCOUNT, "inbox", 10, undefined, { d: "2027-01-02T00:00:00.000Z", i: 2 },
    );

    const { sql, params } = renderWhere(harness.getWhere());
    expect(sql).toContain('"date", "mail_message_metadata"."id") <');
    expect(params).toContain("2027-01-02T00:00:00.000Z");
    expect(params).toContain(2);
  });

  it("BITE: a null-dated cursor keeps the null block AND everything dated after it — a bare row comparison would drop every dated row", async () => {
    const harness = makeDb([]);
    await new MailMetadataService(harness.db).listCached(
      MEMBERSHIP, ORG, ACCOUNT, "inbox", 10, undefined, { d: null, i: 40 },
    );

    const { sql, params } = renderWhere(harness.getWhere());
    expect(sql).toContain("is null");
    expect(sql).toContain("is not null");
    expect(params).toContain(40);
  });
});

describe("MailMetadataService.listCached — indexed search", () => {
  it("goes through app.search_mail_message_ids and filters on the returned ids", async () => {
    const harness = makeDb([row(5, "2027-01-05T00:00:00.000Z")], [{ id: 5 }, { id: 6 }]);

    await new MailMetadataService(harness.db).listCached(
      MEMBERSHIP, ORG, ACCOUNT, "inbox", 10, "invoice",
    );

    expect(harness.execute).toHaveBeenCalledTimes(1);
    const call = harness.execute.mock.calls[0]?.[0] as SQL;
    const fn = dialect.sqlToQuery(call);
    expect(fn.sql).toContain("app.search_mail_message_ids");
    expect([...fn.params]).toEqual(["invoice", MEMBERSHIP, "inbox", 501]);

    const { sql } = renderWhere(harness.getWhere());
    expect(sql).toContain('"id" in');
    expect(sql).not.toContain("ilike");
  });

  it("falls back to ILIKE when the term is too broad for an id list to be worth building", async () => {
    const overCap = Array.from({ length: 501 }, (_, i) => ({ id: i + 1 }));
    const harness = makeDb([row(5, "2027-01-05T00:00:00.000Z")], overCap);

    await new MailMetadataService(harness.db).listCached(
      MEMBERSHIP, ORG, ACCOUNT, "inbox", 10, "a",
    );

    const { sql } = renderWhere(harness.getWhere());
    expect(sql).toContain("ilike");
    expect(sql).not.toContain('"id" in');
  });

  it("BITE: an EMPTY id list is the answer, not a fallback — a zero-row definer result must not re-derive it with three leading-wildcard ILIKEs", async () => {
    const harness = makeDb([], []);

    const page = await new MailMetadataService(harness.db).listCached(
      MEMBERSHIP, ORG, ACCOUNT, "inbox", 10, "no-such-term",
    );

    expect(harness.execute).toHaveBeenCalledTimes(1);
    const { sql } = renderWhere(harness.getWhere());
    expect(sql).not.toContain("ilike");
    expect(sql).toContain("false");
    expect(page.hasData).toBe(false);
    expect(page.messages).toEqual([]);
  });

  it("falls back to ILIKE rather than 500ing when the helper function is missing", async () => {
    const harness = makeDb([row(5, "2027-01-05T00:00:00.000Z")]);
    (harness.execute as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error("function app.search_mail_message_ids does not exist"), { code: "42883" }),
    );

    const page = await new MailMetadataService(harness.db).listCached(
      MEMBERSHIP, ORG, ACCOUNT, "inbox", 10, "invoice",
    );

    expect(page.hasData).toBe(true);
    expect(renderWhere(harness.getWhere()).sql).toContain("ilike");
  });

  it("BITE: with no query the search helper is never called — the ILIKE branch used to be unreachable, and must not become unconditional", async () => {
    const harness = makeDb([row(5, "2027-01-05T00:00:00.000Z")]);
    await new MailMetadataService(harness.db).listCached(MEMBERSHIP, ORG, ACCOUNT, "inbox", 10);

    expect(harness.execute).not.toHaveBeenCalled();
    expect(renderWhere(harness.getWhere()).sql).not.toContain("ilike");
  });
});

describe("MailMetadataService.isFreshForAccount", () => {
  it("binds org_id explicitly instead of leaning on RLS", async () => {
    let capturedWhere: SQL | undefined;
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockImplementation((pred: SQL) => {
      capturedWhere = pred;
      return { limit };
    });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;

    await new MailMetadataService(db).isFreshForAccount(ORG, ACCOUNT, "inbox");

    const { sql, params } = renderWhere(capturedWhere);
    expect(sql).toContain("org_id");
    expect(params).toContain(ORG);
  });
});
