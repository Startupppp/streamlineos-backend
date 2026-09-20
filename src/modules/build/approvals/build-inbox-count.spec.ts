import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { BuildInboxCountService, pendingApprovalsForActorCondition } from "./build-inbox-count.service";
import { ApprovalsReadService } from "./approvals-read.service";
import type { AccessService } from "../../access/access.service";

const dialect = new PgDialect();

function renderParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

const ORG = "org-1";
const OTHER_ORG = "org-2";
const MEMBERSHIP = 42;
const OTHER_MEMBERSHIP = 99;

function makeCountDb(rows: unknown[]) {
  const where = jest.fn().mockResolvedValue(rows);
  const from = jest.fn().mockReturnValue({ where });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

function makeListDb(rows: unknown[] = []) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

describe("BuildInboxCountService.countPending", () => {
  it("returns the aggregate's count value rather than the number of rows the mock resolves", async () => {
    const { db } = makeCountDb([{ total: 999 }]);
    const result = await new BuildInboxCountService(db).countPending(ORG, MEMBERSHIP);
    expect(result).toBe(999);
  });

  it("binds the caller's orgId into the WHERE predicate", async () => {
    const { db, where } = makeCountDb([{ total: 0 }]);
    await new BuildInboxCountService(db).countPending(ORG, MEMBERSHIP);
    expect(renderParams(where.mock.calls[0]?.[0])).toContain(ORG);
    expect(renderParams(where.mock.calls[0]?.[0])).not.toContain(OTHER_ORG);
  });

  it("binds the caller's own membershipId so another member's pending items are never counted", async () => {
    const { db, where } = makeCountDb([{ total: 0 }]);
    await new BuildInboxCountService(db).countPending(ORG, MEMBERSHIP);
    const params = renderParams(where.mock.calls[0]?.[0]);
    expect(params).toContain(MEMBERSHIP);
    expect(params).not.toContain(OTHER_MEMBERSHIP);
  });

  it("returns zero rather than throwing when the aggregate resolves no row", async () => {
    const { db } = makeCountDb([]);
    const result = await new BuildInboxCountService(db).countPending(ORG, MEMBERSHIP);
    expect(result).toBe(0);
  });

  it("returns zero without issuing a query when the caller has no acting membership", async () => {
    const { db, where } = makeCountDb([{ total: 5 }]);
    const result = await new BuildInboxCountService(db).countPending(ORG, null);
    expect(result).toBe(0);
    expect(where).not.toHaveBeenCalled();
  });

  it("binds the same set of values as the production GET /build/approvals/inbox list predicate, so the count can never disagree with the list", async () => {
    const { db: countDb, where: countWhere } = makeCountDb([{ total: 0 }]);
    await new BuildInboxCountService(countDb).countPending(ORG, MEMBERSHIP);

    const { db: listDb, where: listWhere } = makeListDb([]);
    await new ApprovalsReadService(listDb, {} as unknown as AccessService).getInbox(ORG, MEMBERSHIP, {});

    const countParams = [...renderParams(countWhere.mock.calls[0]?.[0])].sort();
    const listParams = [...renderParams(listWhere.mock.calls[0]?.[0])].sort();
    expect(countParams).toEqual(listParams);
  });

  it("exports the extracted condition builder used by the count query, carrying the org, actor and status/deletion predicate", () => {
    const condition = pendingApprovalsForActorCondition(ORG, MEMBERSHIP);
    expect(renderParams(condition)).toEqual(
      expect.arrayContaining([ORG, MEMBERSHIP, "pending", "escalated"]),
    );
  });
});

describe("BSN-03-024 — badge lifecycle and cross-tenant isolation", () => {
  it("acknowledgement: the predicate omits all decided statuses so deciding an approval immediately removes it from the badge without a cache flush", () => {
    const params = renderParams(pendingApprovalsForActorCondition(ORG, MEMBERSHIP));
    for (const decided of ["approved", "rejected", "cancelled", "changes_requested"]) {
      expect(params).not.toContain(decided);
    }
  });

  it("new-event (pending): a newly requested approval with status 'pending' falls inside the count predicate and appears in the badge", () => {
    expect(renderParams(pendingApprovalsForActorCondition(ORG, MEMBERSHIP))).toContain("pending");
  });

  it("new-event (escalated): an escalated approval remains in the count predicate so escalation does not make the badge disappear", () => {
    expect(renderParams(pendingApprovalsForActorCondition(ORG, MEMBERSHIP))).toContain("escalated");
  });

  it("permission-revocation: a caller whose build membership was revoked has no acting membershipId and receives zero without querying the database", async () => {
    const { db, where } = makeCountDb([{ total: 7 }]);
    expect(await new BuildInboxCountService(db).countPending(ORG, null)).toBe(0);
    expect(where).not.toHaveBeenCalled();
  });

  it("cross-tenant isolation: the same numeric membershipId in two orgs produces independent counts because orgId is always bound in the WHERE predicate", async () => {
    const { db: dbOrg1, where: whereOrg1 } = makeCountDb([{ total: 3 }]);
    const { db: dbOrg2, where: whereOrg2 } = makeCountDb([{ total: 0 }]);
    await new BuildInboxCountService(dbOrg1).countPending(ORG, MEMBERSHIP);
    await new BuildInboxCountService(dbOrg2).countPending(OTHER_ORG, MEMBERSHIP);
    const paramsOrg1 = renderParams(whereOrg1.mock.calls[0]?.[0]);
    const paramsOrg2 = renderParams(whereOrg2.mock.calls[0]?.[0]);
    expect(paramsOrg1).toContain(ORG);
    expect(paramsOrg1).not.toContain(OTHER_ORG);
    expect(paramsOrg2).toContain(OTHER_ORG);
    expect(paramsOrg2).not.toContain(ORG);
  });
});
