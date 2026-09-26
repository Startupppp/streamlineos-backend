import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import { KbPageGrantsService } from "./kb-page-grants.service";

const ORG = "org-1";
const PAGE_ID = 42;
const GRANT_ID = 100;
const ACTOR_MEMBERSHIP = 10;
const TARGET_MEMBERSHIP = 20;

const PAGE_SCOPE = { orgId: ORG, pageId: PAGE_ID, action: "manage" as const, via: "admin" as const };

const NOW = new Date("2024-06-01T00:00:00.000Z");

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(ACTOR_MEMBERSHIP, false),
    ...overrides,
  };
}

function makeGrantRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: GRANT_ID,
    pageId: PAGE_ID,
    membershipId: TARGET_MEMBERSHIP,
    role: null,
    access: "view",
    grantedByMembershipId: ACTOR_MEMBERSHIP,
    createdAt: NOW,
    revokedAt: null,
    ...overrides,
  };
}

function uniqueViolation(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });
}

const dialect = new PgDialect();

function renderedSql(condition: SQL | undefined): string {
  if (!condition) throw new Error("expected a rendered where clause");
  return dialect.sqlToQuery(condition).sql;
}

function makeAuth(overrides: Partial<{
  assertPageAccess: jest.Mock;
  invalidateSpaceScope: jest.Mock;
}> = {}): { assertPageAccess: jest.Mock; invalidateSpaceScope: jest.Mock } {
  return {
    assertPageAccess: jest.fn().mockResolvedValue(PAGE_SCOPE),
    invalidateSpaceScope: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeAudit(): { log: jest.Mock } {
  return { log: jest.fn() };
}

interface SelectCapture {
  conditions: SQL[];
}

function makeSimpleSelectDb(selectResults: Record<string, unknown>[][]): {
  db: Db;
  capture: SelectCapture;
} {
  const capture: SelectCapture = { conditions: [] };
  let callIndex = 0;
  const select = jest.fn().mockImplementation(() => {
    const rows = selectResults[callIndex++] ?? [];
    const limit = jest.fn().mockResolvedValue(rows);
    const orderBy = jest.fn(() => ({ limit }));
    const where = jest.fn((cond: SQL) => {
      capture.conditions.push(cond);
      return { limit, orderBy };
    });
    return { from: jest.fn(() => ({ where })) };
  });
  return { db: { select } as unknown as Db, capture };
}

interface TxMocks {
  txInsert: jest.Mock;
  txUpdateFirstWhere: jest.Mock;
  txUpdateFirstReturning: jest.Mock;
  txUpdateSecondWhere: jest.Mock;
  txDelete: jest.Mock;
}

interface ExecuteCapture {
  calls: SQL[];
}

function makeTxDb(options: {
  selectResults?: Record<string, unknown>[][];
  txInsertRows?: Record<string, unknown>[];
  txUpdateFirstRows?: Record<string, unknown>[];
}): { db: Db; tx: TxMocks; execute: ExecuteCapture } {
  const { selectResults = [], txInsertRows = [], txUpdateFirstRows = [] } = options;
  const execute: ExecuteCapture = { calls: [] };

  let selectCallIndex = 0;
  const select = jest.fn().mockImplementation(() => {
    const rows = selectResults[selectCallIndex++] ?? [];
    const limit = jest.fn().mockResolvedValue(rows);
    return { from: jest.fn(() => ({ where: jest.fn(() => ({ limit })) })) };
  });

  const txInsertReturning = jest.fn().mockResolvedValue(txInsertRows);
  const txInsert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({ returning: txInsertReturning }),
  });

  const txUpdateFirstReturning = jest.fn().mockResolvedValue(txUpdateFirstRows);
  const txUpdateFirstWhere = jest.fn().mockReturnValue(
    Object.assign(Promise.resolve(txUpdateFirstRows), { returning: txUpdateFirstReturning }),
  );
  const txUpdateFirstSet = jest.fn().mockReturnValue({ where: txUpdateFirstWhere });

  const txUpdateSecondWhere = jest.fn().mockResolvedValue([]);
  const txUpdateSecondSet = jest.fn().mockReturnValue({ where: txUpdateSecondWhere });

  const txDelete = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) });

  let txUpdateCallCount = 0;
  const txUpdate = jest.fn().mockImplementation(() => {
    txUpdateCallCount++;
    return txUpdateCallCount === 1
      ? { set: txUpdateFirstSet }
      : { set: txUpdateSecondSet };
  });

  const tx = { insert: txInsert, update: txUpdate, delete: txDelete };
  const transaction = jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));
  const executeMock = jest.fn().mockImplementation((query: SQL) => {
    execute.calls.push(query);
    return Promise.resolve(undefined);
  });

  return {
    db: { select, transaction, execute: executeMock } as unknown as Db,
    tx: { txInsert, txUpdateFirstWhere, txUpdateFirstReturning, txUpdateSecondWhere, txDelete },
    execute,
  };
}

function makeService(
  db: Db,
  auth = makeAuth(),
  audit = makeAudit(),
): KbPageGrantsService {
  return new KbPageGrantsService(
    db,
    auth as never,
    audit as never,
  );
}

describe("KbPageGrantsService.list", () => {
  it("a caller who fails manage-level page access cannot list grants", async () => {
    const auth = makeAuth({
      assertPageAccess: jest.fn().mockRejectedValue(new NotFoundException("Page not found")),
    });
    const { db } = makeSimpleSelectDb([]);
    await expect(makeService(db, auth).list(makeUser(), PAGE_ID, { limit: 10 })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("a caller with manage access receives a cursor page of live grants", async () => {
    const row = makeGrantRow();
    const { db } = makeSimpleSelectDb([[row]]);
    const result = await makeService(db).list(makeUser(), PAGE_ID, { limit: 10 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: GRANT_ID });
  });

  it("a cross-tenant page id surfaces as a NotFoundException not a ForbiddenException", async () => {
    const auth = makeAuth({
      assertPageAccess: jest.fn().mockRejectedValue(new NotFoundException("Page not found")),
    });
    const { db } = makeSimpleSelectDb([]);
    const err = await makeService(db, auth)
      .list(makeUser(), PAGE_ID, { limit: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(BadRequestException);
  });

  it("route denial from assertPageAccess surfaces as a ForbiddenException — 403, not 404", async () => {
    const auth = makeAuth({
      assertPageAccess: jest.fn().mockRejectedValue(new ForbiddenException("No org membership")),
    });
    const { db } = makeSimpleSelectDb([]);
    const err = await makeService(db, auth)
      .list(makeUser(), PAGE_ID, { limit: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it("a NotFoundException and a ForbiddenException from assertPageAccess are distinguishable so hidden pages are 404 and denied actors are 403", async () => {
    const { db: dbA } = makeSimpleSelectDb([]);
    const authA = makeAuth({ assertPageAccess: jest.fn().mockRejectedValue(new NotFoundException("Page not found")) });
    const errA = await makeService(dbA, authA).list(makeUser(), PAGE_ID, { limit: 10 }).catch((e: unknown) => e);

    const { db: dbB } = makeSimpleSelectDb([]);
    const authB = makeAuth({ assertPageAccess: jest.fn().mockRejectedValue(new ForbiddenException("No membership")) });
    const errB = await makeService(dbB, authB).list(makeUser(), PAGE_ID, { limit: 10 }).catch((e: unknown) => e);

    expect(errA).toBeInstanceOf(NotFoundException);
    expect(errB).toBeInstanceOf(ForbiddenException);
    expect(errA).not.toBeInstanceOf(ForbiddenException);
    expect(errB).not.toBeInstanceOf(NotFoundException);
  });

  it("the list query includes a revoked_at IS NULL predicate so revoked grants are excluded", async () => {
    const { db, capture } = makeSimpleSelectDb([[]]);
    await makeService(db).list(makeUser(), PAGE_ID, { limit: 10 });
    expect(capture.conditions.length).toBeGreaterThan(0);
    const sql = renderedSql(capture.conditions[0]);
    expect(sql).toContain("revoked_at");
    expect(sql).toContain("is null");
  });

  it("the list query binds org_id so a cross-tenant page cannot leak grants", async () => {
    const { db, capture } = makeSimpleSelectDb([[]]);
    await makeService(db).list(makeUser(), PAGE_ID, { limit: 10 });
    const q = dialect.sqlToQuery(capture.conditions[0]!);
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(PAGE_ID);
  });
});

describe("KbPageGrantsService.create — authorization", () => {
  it("a cross-tenant page id yields a NotFoundException before any DB mutation", async () => {
    const auth = makeAuth({
      assertPageAccess: jest.fn().mockRejectedValue(new NotFoundException("Page not found")),
    });
    const { db, tx } = makeTxDb({ selectResults: [] });
    await expect(
      makeService(db, auth).create(makeUser(), PAGE_ID, { membershipId: TARGET_MEMBERSHIP, access: "view" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.txInsert).not.toHaveBeenCalled();
  });

  it("a caller with manage access and valid input creates the grant and returns it", async () => {
    const grantRow = makeGrantRow();
    const { db } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], []],
      txInsertRows: [grantRow],
    });
    const result = await makeService(db).create(makeUser(), PAGE_ID, {
      membershipId: TARGET_MEMBERSHIP,
      access: "view",
    });
    expect(result).toMatchObject({ id: GRANT_ID, access: "view" });
  });
});

describe("KbPageGrantsService.create — self-grant rejection", () => {
  it("granting to the actor's own membership is rejected before any DB read", async () => {
    const { db, tx } = makeTxDb({ selectResults: [] });
    await expect(
      makeService(db).create(makeUser(), PAGE_ID, {
        membershipId: ACTOR_MEMBERSHIP,
        access: "edit",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.txInsert).not.toHaveBeenCalled();
  });

  it("granting to a different member succeeds (control for self-grant rejection)", async () => {
    const grantRow = makeGrantRow();
    const { db } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], []],
      txInsertRows: [grantRow],
    });
    await expect(
      makeService(db).create(makeUser(), PAGE_ID, {
        membershipId: TARGET_MEMBERSHIP,
        access: "view",
      }),
    ).resolves.toMatchObject({ id: GRANT_ID });
  });
});

describe("KbPageGrantsService.create — cross-org membership", () => {
  it("a membershipId from another org is a 404 because the membership lookup returns nothing", async () => {
    const { db } = makeTxDb({ selectResults: [[]], txInsertRows: [] });
    await expect(
      makeService(db).create(makeUser(), PAGE_ID, {
        membershipId: TARGET_MEMBERSHIP,
        access: "view",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a membershipId in the same org passes the lookup and creates the grant", async () => {
    const grantRow = makeGrantRow();
    const { db } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], []],
      txInsertRows: [grantRow],
    });
    await expect(
      makeService(db).create(makeUser(), PAGE_ID, {
        membershipId: TARGET_MEMBERSHIP,
        access: "view",
      }),
    ).resolves.toMatchObject({ membershipId: TARGET_MEMBERSHIP });
  });
});

describe("KbPageGrantsService.create — re-granting an existing live grantee", () => {
  it("re-granting a live grantee updates the access level and does not insert a second row", async () => {
    const existingGrant = makeGrantRow({ access: "view" });
    const updatedGrant = makeGrantRow({ access: "edit" });
    const { db, tx } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], [existingGrant]],
      txUpdateFirstRows: [updatedGrant],
    });
    const result = await makeService(db).create(makeUser(), PAGE_ID, {
      membershipId: TARGET_MEMBERSHIP,
      access: "edit",
    });
    expect(tx.txInsert).not.toHaveBeenCalled();
    expect(tx.txUpdateFirstReturning).toHaveBeenCalled();
    expect(result).toMatchObject({ access: "edit" });
  });

  it("granting to a new grantee inserts rather than updates (control)", async () => {
    const newGrant = makeGrantRow();
    const { db, tx } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], []],
      txInsertRows: [newGrant],
    });
    await makeService(db).create(makeUser(), PAGE_ID, {
      membershipId: TARGET_MEMBERSHIP,
      access: "view",
    });
    expect(tx.txInsert).toHaveBeenCalled();
    expect(tx.txUpdateFirstReturning).not.toHaveBeenCalled();
  });

  it("a 23505 unique violation from a concurrent insert becomes a ConflictException", async () => {
    const { db } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], []],
      txInsertRows: [],
    });
    const { db: failDb } = makeTxDb({ selectResults: [[{ id: TARGET_MEMBERSHIP }], []] });
    const tx2 = {
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockRejectedValue(uniqueViolation()) }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }) }),
    };
    (failDb as unknown as { transaction: jest.Mock }).transaction = jest.fn(
      async (fn: (t: typeof tx2) => unknown) => fn(tx2),
    );
    await expect(
      makeService(failDb).create(makeUser(), PAGE_ID, {
        membershipId: TARGET_MEMBERSHIP,
        access: "view",
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    void db;
  });
});

describe("KbPageGrantsService.create — acl_revision bump", () => {
  it("creating a grant (insert path) bumps acl_revision inside the same transaction", async () => {
    const grantRow = makeGrantRow();
    const { db, tx } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], []],
      txInsertRows: [grantRow],
    });
    await makeService(db).create(makeUser(), PAGE_ID, {
      membershipId: TARGET_MEMBERSHIP,
      access: "view",
    });
    expect(tx.txUpdateFirstWhere).toHaveBeenCalled();
    expect(tx.txInsert).toHaveBeenCalled();
  });

  it("re-granting (update path) bumps acl_revision inside the same transaction", async () => {
    const existingGrant = makeGrantRow({ access: "view" });
    const updatedGrant = makeGrantRow({ access: "edit" });
    const { db, tx } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], [existingGrant]],
      txUpdateFirstRows: [updatedGrant],
    });
    await makeService(db).create(makeUser(), PAGE_ID, {
      membershipId: TARGET_MEMBERSHIP,
      access: "edit",
    });
    expect(tx.txUpdateSecondWhere).toHaveBeenCalled();
  });
});

describe("KbPageGrantsService.revoke", () => {
  it("revoking an already-revoked or missing grant is a 404", async () => {
    const { db } = makeTxDb({ txUpdateFirstRows: [] });
    await expect(makeService(db).revoke(makeUser(), PAGE_ID, GRANT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("revoking a live grant sets revokedAt and does not delete the row", async () => {
    const revokedRow = { revokedAt: NOW };
    const { db, tx } = makeTxDb({ txUpdateFirstRows: [revokedRow] });
    await makeService(db).revoke(makeUser(), PAGE_ID, GRANT_ID);
    expect(tx.txUpdateFirstReturning).toHaveBeenCalled();
    expect(tx.txDelete).not.toHaveBeenCalled();
  });

  it("revoking bumps acl_revision inside the same transaction", async () => {
    const revokedRow = { revokedAt: NOW };
    const { db, tx } = makeTxDb({ txUpdateFirstRows: [revokedRow] });
    await makeService(db).revoke(makeUser(), PAGE_ID, GRANT_ID);
    expect(tx.txUpdateSecondWhere).toHaveBeenCalled();
  });

  it("a page the caller cannot manage yields a 404 before any mutation", async () => {
    const auth = makeAuth({
      assertPageAccess: jest.fn().mockRejectedValue(new NotFoundException("Page not found")),
    });
    const { db, tx } = makeTxDb({ txUpdateFirstRows: [] });
    await expect(makeService(db, auth).revoke(makeUser(), PAGE_ID, GRANT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.txUpdateFirstReturning).not.toHaveBeenCalled();
  });
});

describe("KbPageGrantsService — chunk acl_revision sync, so a share does not fence the page out of vector search", () => {
  it("revoke syncs kb_article_chunks.acl_revision for the exact page, not the whole org", async () => {
    const revokedRow = { revokedAt: NOW };
    const { db, execute } = makeTxDb({ txUpdateFirstRows: [revokedRow] });
    await makeService(db).revoke(makeUser(), PAGE_ID, GRANT_ID);

    expect(execute.calls).toHaveLength(1);
    const q = dialect.sqlToQuery(execute.calls[0]!);
    expect(q.sql).toContain("kb_article_chunks");
    expect(q.sql).toContain("acl_revision");
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(PAGE_ID);
  });

  it("create syncs kb_article_chunks.acl_revision after granting access", async () => {
    const grantRow = makeGrantRow();
    const { db, execute } = makeTxDb({
      selectResults: [[{ id: TARGET_MEMBERSHIP }], []],
      txInsertRows: [grantRow],
    });
    await makeService(db).create(makeUser(), PAGE_ID, {
      membershipId: TARGET_MEMBERSHIP,
      access: "view",
    });

    expect(execute.calls).toHaveLength(1);
    const q = dialect.sqlToQuery(execute.calls[0]!);
    expect(q.sql).toContain("kb_article_chunks");
  });

  it("BITE: without the sync call, a revoked grant would bump the page's acl_revision but leave its chunks stale, fencing the page out of vector search for everyone", async () => {
    const revokedRow = { revokedAt: NOW };
    const { db, execute } = makeTxDb({ txUpdateFirstRows: [revokedRow] });
    await makeService(db).revoke(makeUser(), PAGE_ID, GRANT_ID);

    expect(execute.calls.length).toBeGreaterThan(0);
  });
});
