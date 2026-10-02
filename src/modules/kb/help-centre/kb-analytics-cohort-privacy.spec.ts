import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { KbAnalyticsService, CITATION_REUSE_MIN } from "./kb-analytics.service";
import { KbContentGapService, MIN_COHORT_SIZE } from "./kb-content-gap.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const dialect = new PgDialect();

const ASKER_SPACE = 5;
const VISIBLE_PAGE_MARKER = "asker_can_open_this_page";
const ACCESSIBLE_SPACE_IDS = [ASKER_SPACE];

function user(): CurrentUserContext {
  return {
    userId: "user-analyst",
    orgId: "org-1",
    role: "member",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
  } as CurrentUserContext;
}

function render(query: SQL): { sql: string; params: unknown[] } {
  const compiled = dialect.sqlToQuery(query);
  return { sql: compiled.sql, params: compiled.params };
}

function makeAuth() {
  return {
    visiblePagePredicate: jest
      .fn()
      .mockResolvedValue(sql`${sql.raw(VISIBLE_PAGE_MARKER)}`),
    resolveStanding: jest.fn().mockResolvedValue({
      orgId: "org-1",
      userId: "user-analyst",
      membershipId: 7,
      roleSlugs: [],
      isOrgOwner: false,
      isKbAdmin: false,
      accessibleSpaceIds: ACCESSIBLE_SPACE_IDS,
      accessibleProjectIds: [],
      permissionsVersion: 1,
    }),
  };
}

async function citationReuseQuery(): Promise<{ sql: string; params: unknown[] }> {
  let captured: SQL | undefined;
  const db = {
    execute: jest.fn().mockImplementation((query: SQL) => {
      captured = query;
      return Promise.resolve([]);
    }),
  };
  const service = new KbAnalyticsService(db as never, makeAuth() as never);
  await service.citationReuse(user(), {});
  if (captured === undefined) throw new Error("citationReuse issued no query");
  return render(captured);
}

describe("KB citation-reuse analytics — a cited title is disclosed only to a caller who may open the thing it names", () => {
  it("admits no citation kind that is exempted from a visibility subquery, so a restricted article's title cannot ride the aggregate out", async () => {
    const compiled = await citationReuseQuery();

    expect(compiled.sql).not.toMatch(/kind[^\n]{0,20}(<>|!=)/);
  });

  it("carries a visibility fence for the page and article kinds, which share the kb_pages ACL", async () => {
    const compiled = await citationReuseQuery();

    expect(compiled.params).toContain("page");
    expect(compiled.params).toContain("article");
    expect(compiled.sql).toContain(VISIBLE_PAGE_MARKER);
  });

  it("fences the source kind on the asker's accessible spaces rather than on the org alone", async () => {
    const compiled = await citationReuseQuery();

    expect(compiled.params).toContain("source");
    expect(compiled.sql).toContain("kb_sources");
    expect(compiled.params).toContain(ASKER_SPACE);
  });

  it("does not disclose a linked company document's title, whose ACL this service cannot evaluate", async () => {
    const compiled = await citationReuseQuery();

    expect(compiled.params).not.toContain("document");
  });

  it("keeps a minimum-cohort floor above one so a single citation in one other person's conversation discloses nothing", async () => {
    const compiled = await citationReuseQuery();

    expect(CITATION_REUSE_MIN).toBeGreaterThan(1);
    expect(compiled.params).toContain(CITATION_REUSE_MIN);
    expect(compiled.sql).toContain("min(title)");
  });
});

describe("KB page analytics — a per-page cohort of one viewer cannot name a page the caller cannot open", () => {
  function makePagesDb(): { db: unknown; wheres: SQL[] } {
    const wheres: SQL[] = [];
    const chain = {
      leftJoin: jest.fn((): unknown => chain),
      where: jest.fn((where: SQL): unknown => {
        wheres.push(where);
        return chain;
      }),
      groupBy: jest.fn((): unknown => chain),
      having: jest.fn((): unknown => chain),
      orderBy: jest.fn((): unknown => chain),
      limit: jest.fn(() => Promise.resolve([])),
    };
    return {
      db: { select: jest.fn(() => ({ from: jest.fn(() => chain) })) },
      wheres,
    };
  }

  it("binds the caller's page-visibility predicate into the grouped query that projects the page title", async () => {
    const { db, wheres } = makePagesDb();
    const service = new KbAnalyticsService(db as never, makeAuth() as never);

    await service.pages(user(), { limit: 50 });

    expect(wheres).toHaveLength(1);
    expect(render(wheres[0]).sql).toContain(VISIBLE_PAGE_MARKER);
  });

  it("carries whatever the authorization service decides, so a denying predicate reaches the same query (paired control)", async () => {
    const { db, wheres } = makePagesDb();
    const denying = {
      ...makeAuth(),
      visiblePagePredicate: jest.fn().mockResolvedValue(sql`false`),
    };
    const service = new KbAnalyticsService(db as never, denying as never);

    await service.pages(user(), { limit: 50 });

    const compiled = render(wheres[0]).sql;
    expect(compiled).toContain("false");
    expect(compiled).not.toContain(VISIBLE_PAGE_MARKER);
  });
});

describe("KB content-gap analytics — the raw search strings of a cohort smaller than the floor are never returned", () => {
  function makeGapDb(): { db: unknown; havings: SQL[]; selected: string[] } {
    const havings: SQL[] = [];
    const selected: string[] = [];
    const chain = {
      where: jest.fn((): unknown => chain),
      groupBy: jest.fn((): unknown => chain),
      having: jest.fn((having: SQL): unknown => {
        havings.push(having);
        return chain;
      }),
      orderBy: jest.fn((): unknown => chain),
      limit: jest.fn(() => Promise.resolve([])),
    };
    return {
      db: {
        select: jest.fn((projection: Record<string, unknown>) => {
          selected.push(...Object.keys(projection));
          return { from: jest.fn(() => chain) };
        }),
      },
      havings,
      selected,
    };
  }

  it("floors the no-results cohort above one while still projecting the query string it would otherwise disclose", async () => {
    const { db, havings, selected } = makeGapDb();
    const service = new KbContentGapService(db as never, {} as never);

    await service.noResults("org-1", {});

    expect(MIN_COHORT_SIZE).toBeGreaterThan(1);
    expect(selected).toContain("query");
    expect(havings).toHaveLength(1);
    expect(render(havings[0]).params).toContain(MIN_COHORT_SIZE);
  });

  it("floors the content-gap cohort on the same constant", async () => {
    const { db, havings, selected } = makeGapDb();
    const service = new KbContentGapService(db as never, {} as never);

    await service.contentGaps("org-1", {});

    expect(MIN_COHORT_SIZE).toBeGreaterThan(1);
    expect(selected).toContain("query");
    expect(havings).toHaveLength(1);
    expect(render(havings[0]).params).toContain(MIN_COHORT_SIZE);
  });
});
