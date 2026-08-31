import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { decodeCursor, encodeCursor } from "../../common/pagination/cursor";
import { ContactsService } from "./contacts.service";

jest.mock("../party/party-legacy-associations", () => ({
  leadIdsOfParties: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock("../party/party-legacy-employer", () => ({
  partyIdsOfCrmOrgs: jest.fn().mockResolvedValue(new Map()),
  crmOrgIdsOfParties: jest.fn().mockResolvedValue(new Map()),
}));

const dialect = new PgDialect();

type SqlArgOrUndef = ReturnType<typeof and>;

type MockChain = {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  offset: jest.Mock;
  limit: jest.Mock;
};

function buildChain(rowPages: unknown[][], countPages: unknown[][]) {
  const rowQueue = [...rowPages];
  const countQueue = [...countPages];
  const whereConds: SqlArgOrUndef[] = [];

  const chain: MockChain = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    offset: jest.fn(),
    limit: jest.fn(),
  };

  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.offset.mockReturnValue(chain);
  chain.where.mockImplementation((cond: SqlArgOrUndef) => {
    whereConds.push(cond);
    return chain;
  });
  chain.limit.mockImplementation(() => Promise.resolve(rowQueue.shift() ?? []));

  Object.defineProperty(chain, "then", {
    value(
      resolve: (v: unknown) => unknown,
      reject?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(countQueue.shift() ?? []).then(resolve, reject);
    },
    configurable: true,
    writable: true,
  });

  const db = { select: jest.fn().mockReturnValue(chain) };
  return { db, chain, whereConds };
}

function buildService(db: { select: jest.Mock }) {
  const cache = {
    cachedVersioned: jest.fn().mockImplementation(
      (_ns: unknown, _hash: unknown, fn: () => Promise<unknown>) => fn(),
    ),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  };
  const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };
  return new ContactsService(db as never, cache as never, planLimits as never);
}

function contactRow(id: number, name: string): Record<string, unknown> {
  return {
    id,
    orgId: "org-1",
    name,
    email: null,
    phone: null,
    title: null,
    department: null,
    company: null,
    linkedinUrl: null,
    twitterUrl: null,
    websiteUrl: null,
    avatarUrl: null,
    notes: null,
    tags: [],
    deletedAt: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    dealId: null,
    mergedIntoId: null,
    leadPartyId: null,
    employerPartyId: null,
    leadName: null,
    dealName: null,
    crmOrganizationName: null,
  };
}

function renderWhereArg(cond: SqlArgOrUndef): { sql: string; params: unknown[] } {
  if (cond === undefined) throw new Error("where condition is undefined");
  return dialect.sqlToQuery(cond);
}

describe("ContactsService — keyset pagination", () => {
  it("builds a composite (name, id) predicate when a cursor is present, not a bare id >", async () => {
    const cursor = encodeCursor({ sortValue: "Bob", id: "3" });
    const { db, whereConds } = buildChain([[contactRow(50, "Carol")]], []);
    const svc = buildService(db);

    await svc.list("org-1", { limit: 2, cursor });

    const [capturedCond] = whereConds;
    const { sql: sqlText } = renderWhereArg(capturedCond);

    expect(sqlText).toMatch(/"business_parties"\."name" >/);
    expect(sqlText).toMatch(/"business_parties"\."name" =/);
    expect(sqlText).toMatch(/"contact_party_map"\."contact_id" >/);
  });

  it("emits a cursor carrying the sort value, not the row id, when id order disagrees with name order", async () => {
    const alice = contactRow(99, "Alice");
    const bob = contactRow(3, "Bob");
    const carol = contactRow(50, "Carol");

    const { db } = buildChain(
      [
        [alice, bob, carol],
        [carol],
      ],
      [[{ count: 3 }]],
    );
    const svc = buildService(db);

    const page1 = await svc.list("org-1", { limit: 2 });

    expect(page1.hasMore).toBe(true);
    expect(decodeCursor(page1.nextCursor)).toEqual({ sortValue: "Bob", id: "3" });

    const cursor2 = page1.nextCursor ?? undefined;
    const page2 = await svc.list("org-1", { limit: 2, cursor: cursor2 });

    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const allNames = [
      ...page1.items.map((item) => item.name),
      ...page2.items.map((item) => item.name),
    ];
    expect(allNames).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("includes total on the first page and omits it on subsequent pages", async () => {
    const alice = contactRow(99, "Alice");
    const bob = contactRow(3, "Bob");
    const carol = contactRow(50, "Carol");

    const { db } = buildChain(
      [[alice, bob, carol], [carol]],
      [[{ count: 3 }]],
    );
    const svc = buildService(db);

    const page1 = await svc.list("org-1", { limit: 2 });
    expect(page1.total).toBe(3);

    const cursor2 = page1.nextCursor ?? undefined;
    const page2 = await svc.list("org-1", { limit: 2, cursor: cursor2 });
    expect(page2.total).toBeUndefined();
  });

  it("returns the first page instead of throwing for a malformed cursor", async () => {
    const alice = contactRow(99, "Alice");
    const bob = contactRow(3, "Bob");
    const carol = contactRow(50, "Carol");

    const { db } = buildChain([[alice, bob, carol]], [[{ count: 3 }]]);
    const svc = buildService(db);

    const result = await svc.list("org-1", { limit: 2, cursor: "not-a-valid-cursor!!!" });

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
  });
});
