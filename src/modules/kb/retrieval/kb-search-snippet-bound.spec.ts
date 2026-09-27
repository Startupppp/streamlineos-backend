jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { KbSearchService } from "./kb-search.service";
import { KbCandidateService } from "./kb-candidate.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { kbPages } from "../../../db/schema";
import type { Db } from "../../../db/drizzle.module";
import { sql } from "drizzle-orm";

const renderNode = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(renderNode).join(" ");
  if (typeof node !== "object") return String(node);
  const rec = node as Record<string, unknown>;
  if (Array.isArray(rec.queryChunks)) return renderNode(rec.queryChunks);
  if (typeof rec.value === "string" || Array.isArray(rec.value)) return renderNode(rec.value);
  if (typeof rec.name === "string") return rec.name;
  return "";
};

const serialise = (v: unknown): string => renderNode(v).replace(/\s+/g, " ").trim();

const ORG = "org-snippet-bound";

const USER: CurrentUserContext = {
  userId: "u1",
  orgId: ORG,
  isOrgOwner: false,
  role: "member",
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

const SEARCH_INPUT = { q: "hello", page: 1, pageSize: 20 } as const;

function makeSearchScope() {
  return {
    denied: false,
    compose: (_spec: unknown, onScoped: (token: { sql: unknown }) => unknown) =>
      onScoped({ sql: sql`true` }),
  };
}

function trackingTxn(): void {
  jest.requireMock<{ runInTenantTransaction: jest.Mock }>(
    "../../../common/tenant/run-in-tenant-transaction",
  ).runInTenantTransaction.mockImplementation(
    async (_db: unknown, fn: () => Promise<unknown>) => fn(),
  );
}

type QueryNode = Promise<unknown[]> & {
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
};

function makeCapturingDb(): { db: Db; rowProjection: unknown[] } {
  const rowProjection: unknown[] = [];
  let selectCallIndex = 0;

  const node = (): QueryNode => {
    const p = Promise.resolve([]) as unknown as QueryNode;
    p.from = jest.fn(() => node());
    p.where = jest.fn(() => node());
    p.orderBy = jest.fn(() => node());
    p.limit = jest.fn(() => node());
    p.offset = jest.fn(() => Promise.resolve([]));
    return p;
  };

  const db = {
    select: jest.fn((proj: unknown) => {
      if (selectCallIndex === 0) rowProjection.push(proj);
      selectCallIndex += 1;
      return node();
    }),
    execute: jest.fn(() => Promise.resolve([])),
    insert: jest.fn(() => ({ values: jest.fn(() => Promise.resolve([])) })),
  } as unknown as Db;

  return { db, rowProjection };
}

function makeSearchService(db: Db): KbSearchService {
  return new KbSearchService(
    db,
    { recordDetached: jest.fn().mockResolvedValue(undefined) } as never,
    new KbCandidateService(db, null),
    { scopeFor: jest.fn().mockResolvedValue("all") } as never,
    {
      articleRestrictionPredicate: jest.fn().mockResolvedValue(null),
      resolveStanding: jest.fn(),
      resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [1], cacheOutcome: "hit" }),
    } as never,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("KbSearchService — content_text is bounded before transfer to Node", () => {
  it("the rows query projects content_text with a left() cap rather than selecting the full column body for 160-char snippets", async () => {
    const { db, rowProjection } = makeCapturingDb();
    trackingTxn();

    const svc = makeSearchService(db);
    await svc.search(USER, SEARCH_INPUT, makeSearchScope() as never);

    expect(rowProjection).toHaveLength(1);
    const proj = rowProjection[0] as Record<string, unknown>;
    const contentExpr = proj["contentText"];
    expect(contentExpr).toBeDefined();

    const rendered = serialise(contentExpr);
    expect(rendered).toContain("left");
    expect(rendered).toContain("content_text");
  });

  it("control: the raw kbPages.contentText column reference renders without any left() prefix, so the projection assertion above is not vacuously satisfied", () => {
    const rendered = serialise(kbPages.contentText);
    expect(rendered).not.toContain("left");
    expect(rendered).toContain("content_text");
  });
});
