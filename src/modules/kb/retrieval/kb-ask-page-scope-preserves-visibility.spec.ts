import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { KbCandidateService } from "./kb-candidate.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

const ORG = "org-page-scope-acl";
const QUERY = "how does onboarding work";
const VECTOR = "[0.1,0.2]";
const CHUNK_IDS = [7, 8];
const REQUESTED_PAGE_IDS = [10, 20];
const VISIBILITY_SENTINEL = 987654;

function visibilityPredicate(): SQL {
  return sql`kb_pages.space_id = ${VISIBILITY_SENTINEL}`;
}

function makeSelectChain(captureCond: (cond: unknown) => void): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn((cond: unknown) => {
    captureCond(cond);
    return chain;
  });
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue([]);
  return chain;
}

function makeCaptureDb(): { db: Db; getCond: () => SQL } {
  let capturedCond: unknown;
  const chain = makeSelectChain((cond) => {
    capturedCond = cond;
  });
  const db = {
    select: jest.fn().mockReturnValue(chain),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, getCond: () => capturedCond as SQL };
}

describe("KB page scope — a caller-supplied pageIds list never displaces the visibility predicate", () => {
  it("keyword candidates keep the visibility predicate AND the org predicate when pageIds narrows the search, because a scope the caller chose must not become a way to read pages they cannot see", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(
      ORG,
      QUERY,
      10,
      visibilityPredicate(),
      false,
      REQUESTED_PAGE_IDS,
    );

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(VISIBILITY_SENTINEL);
    expect(rendered.params).toContain(ORG);
    for (const id of REQUESTED_PAGE_IDS) {
      expect(rendered.params).toContain(id);
    }
  });

  it("CONTROL: keyword candidates carry the same visibility and org predicates with pageIds omitted, so the assertion above is testing survival of the predicate rather than its mere existence", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, visibilityPredicate(), false, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(VISIBILITY_SENTINEL);
    expect(rendered.params).toContain(ORG);
    for (const id of REQUESTED_PAGE_IDS) {
      expect(rendered.params).not.toContain(id);
    }
  });

  it("vector candidates keep the chunk visibility predicate AND the org predicate when pageIds narrows the search", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(
      ORG,
      VECTOR,
      10,
      visibilityPredicate(),
      false,
      REQUESTED_PAGE_IDS,
    );

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(VISIBILITY_SENTINEL);
    expect(rendered.params).toContain(ORG);
    for (const id of REQUESTED_PAGE_IDS) {
      expect(rendered.params).toContain(id);
    }
  });

  it("CONTROL: vector candidates carry the same visibility and org predicates with pageIds omitted", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, visibilityPredicate(), false, undefined);

    const rendered = dialect.sqlToQuery(getCond());
    expect(rendered.params).toContain(VISIBILITY_SENTINEL);
    expect(rendered.params).toContain(ORG);
    for (const id of REQUESTED_PAGE_IDS) {
      expect(rendered.params).not.toContain(id);
    }
  });
});
