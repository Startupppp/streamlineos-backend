import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SearchService, type SearchResponse } from "./search.service";
import type { AccessService } from "../access/access.service";
import type { CacheService } from "../../common/cache/cache.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { Db } from "../../db/drizzle.module";

/**
 * The equivalence check c12-02 asks for: the probe path and the ILIKE fallback
 * select the same candidates for the same term.
 *
 * Both sides are read from their real source rather than restated here — the
 * probe's column list is parsed out of the migration that defines the function,
 * the fallback's out of the condition the service actually compiles. A change to
 * either side alone breaks the pair.
 */

const dialect = new PgDialect();

const ORG_ID = "org-search-equiv";
const PARTY_CAP_PLUS_ONE = 501;
const DEAL_CAP_PLUS_ONE = 501;
const TICKET_CAP_PLUS_ONE = 1001;

const LEAD = 0;
const DEAL = 1;
const CONTACT = 2;
const CLIENT = 3;
const TICKET = 4;

interface Branch {
  readonly index: number;
  readonly name: string;
  readonly migration: string;
  readonly probeFunction: string;
  readonly capPlusOne: number;
}

const BRANCHES: readonly Branch[] = [
  {
    index: LEAD,
    name: "lead",
    migration: "0499_search_lead_party_probe.sql",
    probeFunction: "search_lead_party_ids",
    capPlusOne: PARTY_CAP_PLUS_ONE,
  },
  {
    index: DEAL,
    name: "deal",
    migration: "0475_crm_search_id_probes.sql",
    probeFunction: "search_deal_ids",
    capPlusOne: DEAL_CAP_PLUS_ONE,
  },
  {
    index: CONTACT,
    name: "contact",
    migration: "0475_crm_search_id_probes.sql",
    probeFunction: "search_contact_party_ids",
    capPlusOne: PARTY_CAP_PLUS_ONE,
  },
  {
    index: CLIENT,
    name: "client",
    migration: "0475_crm_search_id_probes.sql",
    probeFunction: "search_client_party_ids",
    capPlusOne: PARTY_CAP_PLUS_ONE,
  },
  {
    index: TICKET,
    name: "ticket",
    migration: "0425_ticket_search_bounded.sql",
    probeFunction: "search_ticket_ids",
    capPlusOne: TICKET_CAP_PLUS_ONE,
  },
];

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "migrations");

function branchAt(index: number): Branch {
  const branch = BRANCHES[index];
  if (!branch) throw new Error(`no search branch at index ${index}`);
  return branch;
}

function probeBody(branch: Branch): string {
  const text = readFileSync(join(MIGRATIONS_DIR, branch.migration), "utf8");
  const declaration = text.indexOf(`CREATE OR REPLACE FUNCTION app.${branch.probeFunction}(`);
  expect(declaration).toBeGreaterThan(-1);
  const bodyStart = text.indexOf("AS $$", declaration);
  const bodyEnd = text.indexOf("$$;", bodyStart);
  expect(bodyStart).toBeGreaterThan(-1);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return text.slice(bodyStart, bodyEnd);
}

/** Columns the probe function matches, in the `'%' || p_q || '%'` form only. */
function probeColumns(branch: Branch): string[] {
  const matched = probeBody(branch).matchAll(
    /\b\w+\.(\w+)\s+ILIKE\s+'%'\s*\|\|\s*p_q\s*\|\|\s*'%'/gi,
  );
  const cols = [...matched].flatMap((m) => (m[1] ? [m[1]] : []));
  expect(cols.length).toBeGreaterThan(0);
  return [...new Set(cols)].sort();
}

/** Columns the compiled fallback condition matches. */
function fallbackColumns(condition: SQL): string[] {
  const { sql: text } = dialect.sqlToQuery(condition);
  const cols = [...text.matchAll(/"(\w+)"\."(\w+)"\s+ilike/gi)].flatMap((m) => (m[2] ? [m[2]] : []));
  return [...new Set(cols)].sort();
}

function compile(condition: SQL): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(condition);
  return { text, params };
}

interface Fixture {
  readonly id: number;
  readonly cols: Readonly<Record<string, string>>;
}

const FIXTURES: readonly Fixture[] = [
  {
    id: 1,
    cols: {
      name: "Acme Industries",
      email: "hello@acme.test",
      phone: "555-0100",
      company_name: "Acme Holdings",
      contact_person: "Dana Acme",
      title: "Acme onboarding",
    },
  },
  {
    id: 2,
    cols: {
      name: "Globex",
      email: "sales@globex.test",
      phone: "555-0200",
      company_name: "Globex Limited",
      contact_person: "Ravi Menon",
      title: "Globex data import",
    },
  },
  {
    id: 3,
    cols: {
      name: "O'Brien & Co.",
      email: "pat@obrien.test",
      phone: "555-0300",
      company_name: "O'Brien Trading",
      contact_person: "Pat O'Brien",
      title: "O'Brien & Co. renewal",
    },
  },
  {
    id: 4,
    cols: {
      name: "Umbrella",
      email: "ops@umbrella.test",
      phone: "555-0400",
      company_name: "Umbrella Corporation",
      contact_person: "Ada Lin",
      title: "Umbrella quarterly audit",
    },
  },
];

const FIXTURE_COLUMNS = new Set(FIXTURES.flatMap((f) => Object.keys(f.cols)));

/** `col ILIKE '%' || term || '%'` for a term that carries no SQL wildcard. */
function matchesTerm(fixture: Fixture, columns: readonly string[], term: string): boolean {
  const needle = term.toLowerCase();
  return columns.some((column) => (fixture.cols[column] ?? "").toLowerCase().includes(needle));
}

function idsMatching(columns: readonly string[], term: string): number[] {
  for (const column of columns) {
    if (!FIXTURE_COLUMNS.has(column))
      throw new Error(`fixture has no data for searched column "${column}" — add it to FIXTURES`);
  }
  return FIXTURES.filter((f) => matchesTerm(f, columns, term)).map((f) => f.id);
}

function rowForBranch(index: number, fixture: Fixture): Record<string, unknown> {
  const c = fixture.cols;
  switch (index) {
    case LEAD:
      return { id: fixture.id, name: c["name"], email: c["email"], company: c["company_name"], status: "NEW" };
    case DEAL:
      return { id: fixture.id, name: c["name"], value: 1000, stage: "OPEN", contactPerson: c["contact_person"] };
    case CONTACT:
      return { id: fixture.id, name: c["name"], email: c["email"], company: c["company_name"] };
    case CLIENT:
      return { id: fixture.id, name: c["name"], company: c["company_name"], status: "ACTIVE" };
    default:
      return {
        id: fixture.id,
        title: c["title"],
        status: "TODO",
        projectId: 7,
        ticketNumber: fixture.id,
        projectKey: "PRJ",
      };
  }
}

function rowsForIds(index: number, ids: readonly number[]): Record<string, unknown>[] {
  return FIXTURES.filter((f) => ids.includes(f.id)).map((f) => rowForBranch(index, f));
}

const USER: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG_ID,
  role: "EMPLOYEE",
  isOrgOwner: true,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

interface ProbeCall {
  readonly text: string;
  readonly params: unknown[];
}

interface Run {
  readonly response: SearchResponse;
  readonly conditions: (SQL | undefined)[];
  readonly probeCalls: ProbeCall[];
}

type ProbeOutcome =
  | { readonly kind: "rows"; readonly ids: readonly number[] }
  | { readonly kind: "missing" };

interface RunOptions {
  readonly term: string;
  readonly probeFor: (branch: number, term: string) => ProbeOutcome;
  readonly rowsFor: (branch: number, term: string) => Record<string, unknown>[];
}

function undefinedFunctionError(): Error {
  return Object.assign(new Error("function app.search_x_ids(unknown, integer) does not exist"), {
    code: "42883",
  });
}

async function run(options: RunOptions): Promise<Run> {
  const conditions: (SQL | undefined)[] = [];
  const probeCalls: ProbeCall[] = [];
  let probeIndex = 0;
  let selectIndex = 0;

  const db = {
    execute: (statement: SQL) => {
      const { text, params } = compile(statement);
      probeCalls.push({ text, params });
      const branch = PROBE_ORDER[probeIndex++] ?? TICKET;
      const outcome = options.probeFor(branch, options.term);
      if (outcome.kind === "missing") return Promise.reject(undefinedFunctionError());
      return Promise.resolve(outcome.ids.map((id) => ({ id })));
    },
    select: () => {
      const index = selectIndex++;
      const builder = {
        from: () => builder,
        innerJoin: () => builder,
        where: (condition: SQL) => {
          conditions[index] = condition;
          return builder;
        },
        orderBy: () => builder,
        limit: () => builder,
        then: (resolve: (rows: Record<string, unknown>[]) => unknown) =>
          resolve(options.rowsFor(index, options.term)),
      };
      return builder;
    },
  } as unknown as Db;

  const cache = {
    cached: <T>(_key: string, factory: () => Promise<T>) => factory(),
  } as unknown as CacheService;

  const access = {
    scopeFor: jest.fn().mockResolvedValue("all"),
    getModuleState: jest.fn().mockResolvedValue(true),
    getPermissionsVersion: jest.fn().mockResolvedValue(1),
    buildModuleAvailabilityResolver: () => ({
      isCoreModule: () => true,
      getModuleMap: async () => ({}),
      getUserDeniedModules: async () => new Set<string>(),
      getPlanLockedModules: async () => [],
    }),
  } as unknown as AccessService;

  const service = new SearchService(db, cache, access);
  const response = await service.search(USER, options.term, 10);
  return { response, conditions, probeCalls };
}

/**
 * `executeSearch` builds its five branch conditions in one `Promise.all`, so the
 * probes fire — and the selects run — in this order.
 */
const PROBE_ORDER: readonly number[] = [LEAD, DEAL, CONTACT, CLIENT, TICKET];

const ALL_MISSING = (): ProbeOutcome => ({ kind: "missing" });

async function captureFallbackConditions(term: string): Promise<(SQL | undefined)[]> {
  const result = await run({
    term,
    probeFor: ALL_MISSING,
    rowsFor: () => [],
  });
  return result.conditions;
}

describe("global search — probe path and ILIKE fallback are equivalent", () => {
  const TERM = "Acme";

  it("every branch matches the same columns the probe does", async () => {
    const conditions = await captureFallbackConditions(TERM);

    for (const branch of BRANCHES) {
      const condition = conditions[branch.index];
      expect(condition).toBeDefined();
      if (!condition) continue;
      expect({ branch: branch.name, columns: fallbackColumns(condition) }).toEqual({
        branch: branch.name,
        columns: probeColumns(branch),
      });
    }
  });

  it("asks each probe for cap + 1", async () => {
    const result = await run({
      term: TERM,
      probeFor: () => ({ kind: "rows", ids: [1] }),
      rowsFor: () => [],
    });

    expect(result.probeCalls).toHaveLength(BRANCHES.length);
    for (const branch of BRANCHES) {
      const call = result.probeCalls[branch.index];
      expect(call?.text).toContain(`app.${branch.probeFunction}(`);
      expect(call?.params).toEqual([TERM, branch.capPlusOne]);
    }
  });

  it("passes the raw term to both sides, so a wildcard is treated identically", async () => {
    const wildcard = "a%e";
    const conditions = await captureFallbackConditions(wildcard);

    for (const branch of BRANCHES) {
      expect(probeBody(branch)).toContain("'%' || p_q || '%'");
      const condition = conditions[branch.index];
      expect(condition).toBeDefined();
      if (!condition) continue;
      expect(compile(condition).params).toContain(`%${wildcard}%`);
    }
  });
});

describe("global search — the same term returns the same results either way", () => {
  const TERMS: readonly { readonly label: string; readonly term: string }[] = [
    { label: "exact", term: "Acme Industries" },
    { label: "partial", term: "cme" },
    { label: "case-varied", term: "ACME" },
    { label: "punctuation-bearing", term: "O'Brien & Co." },
    { label: "no-match", term: "zzzznothing" },
  ];

  it.each(TERMS)("$label term: probe results equal fallback results", async ({ term }) => {
    const fallbackConditions = await captureFallbackConditions(term);
    const columnsFor = new Map<number, string[]>();
    for (const branch of BRANCHES) {
      const condition = fallbackConditions[branch.index];
      expect(condition).toBeDefined();
      if (condition) columnsFor.set(branch.index, fallbackColumns(condition));
    }

    const viaProbe = await run({
      term,
      probeFor: (branch) => ({ kind: "rows", ids: idsMatching(probeColumns(branchAt(branch)), term) }),
      rowsFor: (branch) => rowsForIds(branch, idsMatching(probeColumns(branchAt(branch)), term)),
    });

    const viaFallback = await run({
      term,
      probeFor: ALL_MISSING,
      rowsFor: (branch) => rowsForIds(branch, idsMatching(columnsFor.get(branch) ?? [], term)),
    });

    expect(viaProbe.response).toEqual(viaFallback.response);
  });

  it("an empty term short-circuits before any probe runs", async () => {
    const result = await run({
      term: "   ",
      probeFor: () => ({ kind: "rows", ids: [] }),
      rowsFor: () => [],
    });

    expect(result.response).toEqual({ results: [], total: 0 });
    expect(result.probeCalls).toHaveLength(0);
  });
});

describe("global search — a branch falls back on its own", () => {
  const TERM = "Acme";

  it("a probe over its cap produces exactly the fallback condition", async () => {
    const fallbackConditions = await captureFallbackConditions(TERM);
    const overCap = await run({
      term: TERM,
      probeFor: (branch) => ({
        kind: "rows",
        ids: Array.from({ length: branchAt(branch).capPlusOne + 1 }, (_, i) => i + 1),
      }),
      rowsFor: () => [],
    });

    for (const branch of BRANCHES) {
      const viaOverCap = overCap.conditions[branch.index];
      const viaMissing = fallbackConditions[branch.index];
      expect(viaOverCap).toBeDefined();
      expect(viaMissing).toBeDefined();
      if (!viaOverCap || !viaMissing) continue;
      expect(compile(viaOverCap)).toEqual(compile(viaMissing));
    }
  });

  it("one missing probe does not push the other branches onto the fallback", async () => {
    const result = await run({
      term: TERM,
      probeFor: (branch) => (branch === DEAL ? { kind: "missing" } : { kind: "rows", ids: [1] }),
      rowsFor: () => [],
    });

    const dealCondition = result.conditions[DEAL];
    const leadCondition = result.conditions[LEAD];
    expect(dealCondition).toBeDefined();
    expect(leadCondition).toBeDefined();
    if (!dealCondition || !leadCondition) return;
    expect(compile(dealCondition).text).toContain("ilike");
    expect(compile(leadCondition).text).not.toContain("ilike");
  });

  it("a probe with no rows yields no candidates rather than a scan", async () => {
    const result = await run({
      term: "zzzznothing",
      probeFor: () => ({ kind: "rows", ids: [] }),
      rowsFor: () => [],
    });

    for (const branch of BRANCHES) {
      const condition = result.conditions[branch.index];
      expect(condition).toBeDefined();
      if (!condition) continue;
      expect(compile(condition).text).not.toContain("ilike");
    }
    expect(result.response).toEqual({ results: [], total: 0 });
  });
});
