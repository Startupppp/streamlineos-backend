import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { MailMetadataService } from "./mail-metadata.service";
import type { MailMessageSummary } from "./dto/mail-schemas";

const dialect = new PgDialect();

const ATTACKER = "org-attacker";
const OWNER = "org-owner";
const ALICE = 101;
const BOB = 202;
const ACCOUNT_ID = 42;

function makeMessage(id: string): MailMessageSummary {
  return {
    id,
    threadId: null,
    accountId: ACCOUNT_ID,
    provider: "gmail",
    from: { email: "sender@example.com", name: "Sender" },
    to: [],
    subject: `Subject ${id}`,
    snippet: "",
    date: new Date().toISOString(),
    isRead: false,
    isStarred: false,
    hasAttachments: false,
  };
}

describe("MailMetadataService.listCached — tenant isolation", () => {
  function makeDb() {
    let capturedWhere: SQL | undefined;
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockImplementation((pred: SQL) => {
      capturedWhere = pred;
      return { orderBy };
    });
    const from = jest.fn().mockReturnValue({ where });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
    return { db, getWhere: () => capturedWhere };
  }

  it("DENY: predicate binds ATTACKER org and membership, owner org absent", async () => {
    const { db, getWhere } = makeDb();
    const service = new MailMetadataService(db);
    await service.listCached(ALICE, ATTACKER, ACCOUNT_ID, "inbox", 25);

    const { sql, params } = dialect.sqlToQuery(getWhere() as SQL);
    expect(sql).toContain("org_id");
    expect(sql).toContain("user_membership_id");
    expect(params).toContain(ATTACKER);
    expect(params).not.toContain(OWNER);
  });

  it("CONTROL: predicate binds OWNER org and correct membership", async () => {
    const { db, getWhere } = makeDb();
    const service = new MailMetadataService(db);
    await service.listCached(BOB, OWNER, ACCOUNT_ID, "inbox", 25);

    const { sql, params } = dialect.sqlToQuery(getWhere() as SQL);
    expect(sql).toContain("org_id");
    expect(sql).toContain("user_membership_id");
    expect(params).toContain(OWNER);
    expect(params).toContain(BOB);
    expect(params).not.toContain(ATTACKER);
  });
});

describe("MailMetadataService.upsertBatch — tenant isolation", () => {
  function makeDb() {
    let capturedValues: Array<{ orgId: string; userMembershipId: number }> = [];
    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockImplementation((rows: typeof capturedValues) => {
      capturedValues = rows;
      return { onConflictDoUpdate };
    });
    const db = { insert: jest.fn().mockReturnValue({ values }) } as unknown as Db;
    return { db, getValues: () => capturedValues };
  }

  it("DENY: all inserted rows carry ATTACKER org, owner org absent", async () => {
    const { db, getValues } = makeDb();
    const service = new MailMetadataService(db);
    await service.upsertBatch(ACCOUNT_ID, ALICE, ATTACKER, "inbox", [makeMessage("m1"), makeMessage("m2")]);

    const rows = getValues();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.orgId === ATTACKER)).toBe(true);
    expect(rows.every((r) => r.orgId !== OWNER)).toBe(true);
    expect(rows.every((r) => r.userMembershipId === ALICE)).toBe(true);
  });

  it("CONTROL: all inserted rows carry OWNER org and correct membership", async () => {
    const { db, getValues } = makeDb();
    const service = new MailMetadataService(db);
    await service.upsertBatch(ACCOUNT_ID, BOB, OWNER, "inbox", [makeMessage("m3")]);

    const rows = getValues();
    expect(rows.length).toBe(1);
    expect(rows[0]?.orgId).toBe(OWNER);
    expect(rows[0]?.userMembershipId).toBe(BOB);
    expect(rows[0]?.orgId).not.toBe(ATTACKER);
  });
});

describe("MailMetadataService.updateState — tenant isolation", () => {
  function makeDb() {
    let capturedWhere: SQL | undefined;
    const where = jest.fn().mockImplementation((pred: SQL) => {
      capturedWhere = pred;
      return undefined;
    });
    const set = jest.fn().mockReturnValue({ where });
    const db = { update: jest.fn().mockReturnValue({ set }) } as unknown as Db;
    return { db, getWhere: () => capturedWhere };
  }

  it("DENY: predicate binds ATTACKER org and membership, owner org absent", async () => {
    const { db, getWhere } = makeDb();
    const service = new MailMetadataService(db);
    await service.updateState(ACCOUNT_ID, ALICE, ATTACKER, "msg-1", { isRead: true });

    const { sql, params } = dialect.sqlToQuery(getWhere() as SQL);
    expect(sql).toContain("org_id");
    expect(sql).toContain("user_membership_id");
    expect(params).toContain(ATTACKER);
    expect(params).not.toContain(OWNER);
  });

  it("CONTROL: predicate binds OWNER org and correct membership", async () => {
    const { db, getWhere } = makeDb();
    const service = new MailMetadataService(db);
    await service.updateState(ACCOUNT_ID, BOB, OWNER, "msg-2", { isStarred: false });

    const { sql, params } = dialect.sqlToQuery(getWhere() as SQL);
    expect(sql).toContain("org_id");
    expect(sql).toContain("user_membership_id");
    expect(params).toContain(OWNER);
    expect(params).toContain(BOB);
    expect(params).not.toContain(ATTACKER);
  });
});
