import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DealsAnalyticsService, type DealsViewScope } from "./deals-analytics.service";
import { DealsForecastService } from "./deals-forecast.service";
import { ScopedRead } from "../access/scoped-read";

/**
 * Every analytic behind `crm:deals:read` answered for the whole organisation.
 *
 * `listDeals` has always narrowed on `deals.assignedToId`, and `getDeal` was made
 * to in 7b35e781e. This controller has five more routes on that same key —
 * `stats`, `aging`, `forecast`, `win-loss` and `:dealId/health` — and not one of
 * them took a caller id. A rep granted `own` saw six deals on the board and the
 * organisation's whole pipeline value in the tile above it.
 *
 * `aging` is the one that returns records rather than totals: up to a hundred
 * deal rows with name, value, stage and assignee, which made it a second,
 * unnarrowed deals list sitting behind the narrowed one.
 *
 * The compiled predicate is the assertion. Every fixture answers the same empty
 * result whatever the WHERE says, so "it returned nothing" would pass against
 * the unscoped code too.
 */

const sqlText = (statement: SQL): string => new PgDialect().sqlToQuery(statement).sql;

/** `applyScope` at `own` over `deals.assigned_to_id` — the column the list uses. */
const OWNER_PREDICATE = '"assigned_to_id" =';

const REP: DealsViewScope = ScopedRead.of("org-1", "rep-1", "own");
const MANAGER: DealsViewScope = ScopedRead.of("org-1", "manager-1", "all");
const DENIED: DealsViewScope = ScopedRead.of("org-1", "rep-1", "none");

interface Recorder {
  db: never;
  wheres: SQL[];
  cacheKeys: string[];
}

function recording(rows: unknown[] = []): Recorder {
  const wheres: SQL[] = [];
  const cacheKeys: string[] = [];

  const chain: Record<string, unknown> = {};
  for (const step of ["from", "leftJoin", "innerJoin", "groupBy", "orderBy", "limit", "offset"]) {
    chain[step] = () => chain;
  }
  chain.where = (predicate: SQL) => {
    wheres.push(predicate);
    return chain;
  };
  chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);

  const db = {
    select: () => chain,
    query: {
      deals: {
        findFirst: (args: { where: SQL }) => {
          wheres.push(args.where);
          return Promise.resolve({
            stage: "PROPOSAL",
            updatedAt: new Date().toISOString(),
            expectedCloseDate: null,
            value: "100000",
            lastContactDate: null,
            probability: 50,
            activities: [],
          });
        },
      },
      crmForecastSnapshots: {
        findFirst: () =>
          Promise.resolve({
            data: {
              byCategory: [],
              byRep: [],
              totalWeighted: 1,
              totalBestCase: 2,
              totalDeals: 3,
              period: "2026-07",
            },
          }),
      },
    },
  } as unknown as never;

  return { db, wheres, cacheKeys };
}

function serviceWith(rec: Recorder): DealsAnalyticsService {
  const cache = {
    cached: (key: string, fetcher: () => Promise<unknown>): Promise<unknown> => {
      rec.cacheKeys.push(key);
      return fetcher();
    },
  } as never;
  const crmMetadata = {
    getAggregate: (_orgId: string) =>
      Promise.resolve({
        pipelines: [],
        stages: [
          { key: "OPEN", stageType: "open", isActive: true, probability: 20 },
          { key: "WON", stageType: "won", isActive: true, probability: 100 },
          { key: "LOST", stageType: "lost", isActive: true, probability: 0 },
        ],
      }),
  } as never;
  const forecastModel = {
    basisFor: (_orgId: string, readiness: unknown) =>
      Promise.resolve({ kind: "naive-weighted", reason: "not-trained-yet", readiness }),
    probabilitiesForOpenDeals: (_orgId: string) => Promise.resolve(new Map<number, number>()),
  } as never;
  // The forecast moved to `DealsForecastService`, which the analytics service
  // delegates to. Built for real over the same recorder, so the forecast and
  // snapshot assertions below still execute the reads they are about.
  const forecast = new DealsForecastService(rec.db, cache, crmMetadata, forecastModel);
  return new DealsAnalyticsService(rec.db, cache, crmMetadata, forecast);
}

const allSql = (rec: Recorder): string => rec.wheres.map(sqlText).join("\n---\n");
const count = (rec: Recorder): number => allSql(rec).split(OWNER_PREDICATE).length - 1;

describe("deals analytics narrow to the deals the caller may see", () => {
  describe("getDealHealth", () => {
    it("narrows to the caller's own deals", async () => {
      // A second detail read of one deal by id, on a different controller from
      // the one 7b35e781e repaired, behind the same key. Its factors ARE the
      // columns: "Past expected close date", "No updates in 30+ days".
      const rec = recording();

      await serviceWith(rec).getDealHealth("org-1", 5, REP);

      expect(allSql(rec)).toContain(OWNER_PREDICATE);
    });

    it("makes every deal unreachable at scope none", async () => {
      const rec = recording();

      await serviceWith(rec).getDealHealth("org-1", 5, DENIED);

      expect(allSql(rec)).toContain("false");
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getDealHealth("org-1", 5, MANAGER);

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });

  describe("getStats", () => {
    it("narrows both tiles, not one of them", async () => {
      // Active pipeline and won value are two separate reads. Counting catches a
      // fix applied to the first and not the second, which is this whole defect
      // class in miniature.
      const rec = recording();

      await serviceWith(rec).getStats("org-1", REP);

      expect(count(rec)).toBe(2);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getStats("org-1", MANAGER);

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });

  describe("getAging", () => {
    it("narrows the stale-deal list", async () => {
      const rec = recording();

      await serviceWith(rec).getAging("org-1", REP);

      expect(allSql(rec)).toContain(OWNER_PREDICATE);
    });

    it("gives the narrowed list its own cache entry", async () => {
      const rep = recording();
      await serviceWith(rep).getAging("org-1", REP);

      const other = recording();
      await serviceWith(other).getAging("org-1", ScopedRead.of("org-1", "rep-2", "own"));

      const manager = recording();
      await serviceWith(manager).getAging("org-1", MANAGER);

      expect(rep.cacheKeys[0]).not.toEqual(other.cacheKeys[0]);
      expect(rep.cacheKeys[0]).not.toEqual(manager.cacheKeys[0]);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getAging("org-1", MANAGER);

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });

  describe("getWinLoss", () => {
    it("narrows all three reads — won, lost, and the lost-reason breakdown", async () => {
      // The reasons are free text somebody typed about why a deal was lost.
      const rec = recording();

      await serviceWith(rec).getWinLoss("org-1", REP);

      expect(count(rec)).toBe(3);
    });

    it("gives the narrowed win rate its own cache entry", async () => {
      const rep = recording();
      await serviceWith(rep).getWinLoss("org-1", REP);

      const manager = recording();
      await serviceWith(manager).getWinLoss("org-1", MANAGER);

      expect(rep.cacheKeys[0]).not.toEqual(manager.cacheKeys[0]);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getWinLoss("org-1", MANAGER);

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });

  describe("getForecast", () => {
    it("narrows the open pipeline and leaves the closed history alone", async () => {
      /*
       * The two reads take different scopes ON PURPOSE, and this is the assertion
       * that says so. Every money figure in the response comes out of the open
       * pipeline, which is the caller's. The closed history produces only
       * `basis` — whether THIS ORGANISATION has enough closed deals to have
       * trained a model — which is one fact about the product's state, identical
       * for every caller. Narrowing it would tell a rep with three closed deals
       * that their organisation cannot be forecast.
       *
       * So: exactly one of the two carries the owner predicate. Both would be
       * over-narrowing and neither would be the defect.
       */
      const rec = recording();

      await serviceWith(rec).getForecast("org-1", REP);

      expect(count(rec)).toBe(1);
    });

    it("does not cache a narrowed forecast under the shared key", async () => {
      /*
       * `CACHE_KEYS.dealsForecast` is invalidated BY EXACT KEY from three write
       * paths in deals-crud. A narrowed entry hung off a suffixed key would be
       * unreachable by those invalidations, so a rep would go on reading a
       * forecast containing a deal deleted ten minutes earlier. The narrowed one
       * is computed each time instead; the shared entry keeps its key, its
       * invalidation and its value.
       */
      const rep = recording();
      await serviceWith(rep).getForecast("org-1", REP);

      const manager = recording();
      await serviceWith(manager).getForecast("org-1", MANAGER);

      expect(rep.cacheKeys).toHaveLength(0);
      expect(manager.cacheKeys).toEqual(["deals:forecast:org-1"]);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getForecast("org-1", MANAGER);

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });

  describe("a forecast snapshot", () => {
    it("is the organisation's figure whoever captured it", async () => {
      /*
       * `compareForecastSnapshots` subtracts a stored ORGANISATION snapshot from
       * a freshly built forecast. If that rebuild took the caller's scope, the
       * delta would be arithmetic between two different populations — and two
       * captures of one period taken by two different people would disagree.
       * The route is on `crm:deals:forecast`, which the catalog does not declare
       * scopable: the same statement, in the permission catalog.
       *
       * The service reaches `buildForecast` here without a caller scope at all,
       * so the assertion is that no owner predicate appears — checked against a
       * call made by a rep, which is the case that would break it.
       */
      const rec = recording();

      await serviceWith(rec).compareForecastSnapshots("org-1", { period: "2026-07" });

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });
});
