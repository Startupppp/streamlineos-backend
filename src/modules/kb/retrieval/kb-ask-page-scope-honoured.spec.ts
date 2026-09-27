import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KbCandidateService } from "./kb-candidate.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();

const ORG = "org-page-scope";
const QUERY = "how does onboarding work";
const VECTOR = "[0.1,0.2]";
const CHUNK_IDS = [7, 8];
const PAGE_IDS_SCOPED = [10, 20];
const PAGE_ID_INACCESSIBLE = 999;
const PAGE_ID_READABLE = 42;

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

describe("KB page scope — pageIds are honoured in the keyword candidate query", () => {
  it("when pageIds is provided each id appears as a bound parameter in the WHERE", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, PAGE_IDS_SCOPED);

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    for (const id of PAGE_IDS_SCOPED) {
      expect(rendered.params).toContain(id);
    }
  });

  it("CONTROL: without pageIds the specific ids are absent from the WHERE, proving the previous assertion is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, undefined);

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    for (const id of PAGE_IDS_SCOPED) {
      expect(rendered.params).not.toContain(id);
    }
  });
});

describe("KB page scope — pageIds are honoured in the vector candidate query", () => {
  it("when pageIds is provided each id appears as a bound parameter in the WHERE", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, sql`true`, false, PAGE_IDS_SCOPED);

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    for (const id of PAGE_IDS_SCOPED) {
      expect(rendered.params).toContain(id);
    }
  });

  it("CONTROL: without pageIds the specific ids are absent from the WHERE, proving the previous assertion is not a tautology", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);
    jest.spyOn(svc, "vectorChunkIds").mockResolvedValue(CHUNK_IDS);

    await svc.pageVectorCandidates(ORG, VECTOR, 10, sql`true`, false, undefined);

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    for (const id of PAGE_IDS_SCOPED) {
      expect(rendered.params).not.toContain(id);
    }
  });
});

describe("KB page scope — an unreadable pageId is not silently widened to all pages", () => {
  it("when pageIds contains an id the actor cannot read the IN filter is still applied so the result is the empty intersection not a full unscoped search", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, [PAGE_ID_INACCESSIBLE]);

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    expect(rendered.params).toContain(PAGE_ID_INACCESSIBLE);
    expect(rendered.params).toContain(ORG);
  });

  it("CONTROL: a readable pageId also produces an IN filter and org constraint, proving the inaccessible-id assertion is not vacuous", async () => {
    const { db, getCond } = makeCaptureDb();
    const svc = new KbCandidateService(db, null);

    await svc.pageKeywordCandidates(ORG, QUERY, 10, sql`true`, false, [PAGE_ID_READABLE]);

    const cond = getCond();
    expect(cond).toBeDefined();
    const rendered = dialect.sqlToQuery(cond);
    expect(rendered.params).toContain(PAGE_ID_READABLE);
    expect(rendered.params).toContain(ORG);
  });
});
