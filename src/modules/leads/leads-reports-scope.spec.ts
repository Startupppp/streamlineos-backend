import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { LeadsReportsService } from "./leads-reports.service";

/**
 * Four lead reports read the whole organisation while the lead list narrowed.
 *
 * `crm:leads:view` is declared `scopable: true`. `getLeadAnalytics`, on the same
 * controller behind the same key, has always taken a view scope and pushed
 * `applyScope(..., { ownerColumn: businessParties.ownerUserId })`.
 * `getDashboardMetrics`, `getSourceReport`, `getFollowUps` and
 * `getUnverifiedLeads` took NO CALLER ID AT ALL, so a rep granted `own` read
 * their own conversion rate on one screen and the organisation's on the next —
 * and, on the two that return rows rather than totals, the organisation's leads
 * with name, email, phone and free-text follow-up notes attached.
 *
 * The compiled predicate is the assertion. Every fixture below answers the same
 * empty result whatever the WHERE says, so "it returned nothing" would pass
 * against the unscoped code too.
 */

const sqlText = (statement: SQL): string => new PgDialect().sqlToQuery(statement).sql;

/** The `own` predicate, as `applyScope` renders it against the party's owner. */
const OWNER_PREDICATE = '"owner_user_id" =';

/** The `own` predicate against `lead_activities.user_id`, which is not the same column. */
const LOGGED_BY_PREDICATE = '"user_id" =';

interface Recorder {
  db: never;
  wheres: SQL[];
  cacheKeys: string[];
}

/**
 * A db whose every builder step returns the same thenable, recording each
 * `where` it is handed.
 *
 * The chain has to be thenable because `getDashboardMetrics` reads one of its
 * counts with `.then((r) => r[0]?.cnt ?? 0)` rather than `await`, and a double
 * that only supported `await` would make that call site untestable.
 */
function recording(rows: unknown[] = []): Recorder {
  const wheres: SQL[] = [];
  const cacheKeys: string[] = [];
  const chain: Record<string, unknown> = {};
  for (const step of ["from", "innerJoin", "leftJoin", "groupBy", "orderBy", "limit", "offset"]) {
    chain[step] = () => chain;
  }
  chain.where = (predicate: SQL) => {
    wheres.push(predicate);
    return chain;
  };
  chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);

  const db = { select: () => chain } as unknown as never;
  return { db, wheres, cacheKeys };
}

function serviceWith(rec: Recorder): LeadsReportsService {
  const cache = {
    cachedVersioned: (
      _namespace: string,
      key: string,
      fetcher: () => Promise<unknown>,
    ): Promise<unknown> => {
      rec.cacheKeys.push(key);
      return fetcher();
    },
  } as never;
  const teamReports = {} as never;
  const access = {
    membersWithPermission: (_orgId: string, _key: string) => Promise.resolve([]),
  } as never;
  return new LeadsReportsService(rec.db, cache, teamReports, access);
}

/** Every predicate the method built, as one string, so an assertion can look across them. */
const allSql = (rec: Recorder): string => rec.wheres.map(sqlText).join("\n---\n");

describe("lead reports narrow to the leads the caller may see", () => {
  describe("getDashboardMetrics", () => {
    it("narrows the status counts and the follow-up count to the caller's own leads", async () => {
      const rec = recording();

      await serviceWith(rec).getDashboardMetrics("org-1", { scope: "own", userId: "rep-1" });

      // Three lead-side reads: the status roll-up and the follow-up count both
      // carry the owner predicate. Counting occurrences rather than asserting
      // "contains" catches a fix applied to one of the two and not the other,
      // which is the exact shape of the defect being repaired.
      const owned = allSql(rec).split(OWNER_PREDICATE).length - 1;
      expect(owned).toBe(2);
    });

    it("narrows the call and meeting tiles to the activities the caller logged", async () => {
      const rec = recording();

      await serviceWith(rec).getDashboardMetrics("org-1", { scope: "own", userId: "rep-1" });

      // `lead_activities` has no owner column, so this one narrows on who did
      // the work. Asserted separately from the lead-side predicate because the
      // two are different columns and a fix that used the wrong one would
      // silently answer about the wrong person.
      expect(allSql(rec)).toContain(LOGGED_BY_PREDICATE);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getDashboardMetrics("org-1", { scope: "all", userId: "manager-1" });

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
      expect(allSql(rec)).not.toContain(LOGGED_BY_PREDICATE);
    });

    it("makes every tile unreachable at scope none", async () => {
      const rec = recording();

      await serviceWith(rec).getDashboardMetrics("org-1", { scope: "none", userId: "rep-1" });

      expect(allSql(rec)).toContain("false");
    });

    it("gives the narrowed figure its own cache entry", async () => {
      /*
       * `cachedVersioned` keys on the organisation, so a narrowed report reusing
       * the org-wide key would serve one rep's numbers to the next rep and to
       * the manager who asked for the organisation's — a worse leak than the one
       * this fixes, and a wrong number besides.
       */
      const own = recording();
      await serviceWith(own).getDashboardMetrics("org-1", { scope: "own", userId: "rep-1" });

      const other = recording();
      await serviceWith(other).getDashboardMetrics("org-1", { scope: "own", userId: "rep-2" });

      const wide = recording();
      await serviceWith(wide).getDashboardMetrics("org-1", { scope: "all", userId: "manager-1" });

      expect(own.cacheKeys[0]).not.toEqual(other.cacheKeys[0]);
      expect(own.cacheKeys[0]).not.toEqual(wide.cacheKeys[0]);
    });

    it("keeps one shared entry for every caller who sees the whole organisation", () => {
      // `all` answers the same thing for everyone holding it, so the common case
      // must not fan the cache out per user.
      const first = recording();
      const second = recording();
      return Promise.all([
        serviceWith(first).getDashboardMetrics("org-1", { scope: "all", userId: "manager-1" }),
        serviceWith(second).getDashboardMetrics("org-1", { scope: "all", userId: "owner-1" }),
      ]).then(() => {
        expect(first.cacheKeys[0]).toEqual(second.cacheKeys[0]);
      });
    });
  });

  describe("getSourceReport", () => {
    it("narrows the source breakdown to the caller's own leads", async () => {
      const rec = recording();

      await serviceWith(rec).getSourceReport("org-1", { scope: "own", userId: "rep-1" });

      expect(allSql(rec)).toContain(OWNER_PREDICATE);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getSourceReport("org-1", { scope: "all", userId: "manager-1" });

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });

    it("gives the narrowed breakdown its own cache entry", async () => {
      const own = recording();
      await serviceWith(own).getSourceReport("org-1", { scope: "own", userId: "rep-1" });

      const wide = recording();
      await serviceWith(wide).getSourceReport("org-1", { scope: "all", userId: "manager-1" });

      expect(own.cacheKeys[0]).not.toEqual(wide.cacheKeys[0]);
    });
  });

  describe("getFollowUps", () => {
    it("narrows to the caller's own leads", async () => {
      // Not an aggregate: this returns lead rows with name, email, phone and the
      // free-text notes somebody typed about a person.
      const rec = recording();

      await serviceWith(rec).getFollowUps("org-1", {}, { scope: "own", userId: "rep-1" });

      expect(allSql(rec)).toContain(OWNER_PREDICATE);
    });

    it("makes every follow-up unreachable at scope none", async () => {
      const rec = recording();

      await serviceWith(rec).getFollowUps("org-1", {}, { scope: "none", userId: "rep-1" });

      expect(allSql(rec)).toContain("false");
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getFollowUps("org-1", {}, { scope: "all", userId: "manager-1" });

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });

  describe("getUnverifiedLeads", () => {
    it("narrows to the caller's own leads", async () => {
      // The projection is the WHOLE lead, up to a hundred of them.
      const rec = recording();

      await serviceWith(rec).getUnverifiedLeads("org-1", { scope: "own", userId: "rep-1" });

      expect(allSql(rec)).toContain(OWNER_PREDICATE);
    });

    it("leaves a manager at scope all exactly as wide as they were", async () => {
      const rec = recording();

      await serviceWith(rec).getUnverifiedLeads("org-1", { scope: "all", userId: "manager-1" });

      expect(allSql(rec)).not.toContain(OWNER_PREDICATE);
    });
  });

  describe("getLeadAnalytics", () => {
    it("narrows the previous period with the period it is compared against", async () => {
      /*
       * The current period went through the view scope and the previous one did
       * not, so a rep at `own` was shown their own total beside the
       * organisation's total from a month earlier. The delta between them was
       * arithmetic over two different populations, and it disclosed the
       * organisation's lead count to the one caller the rest of this method was
       * careful not to disclose it to.
       *
       * Four lead-side reads carry the scope once it is right — totals, previous
       * period, by-source and by-assignee — so the count is what distinguishes
       * the fix from the defect.
       */
      const rec = recording();

      await serviceWith(rec).getLeadAnalytics("org-1", {}, { scope: "own", userId: "rep-1" });

      const owned = allSql(rec).split(OWNER_PREDICATE).length - 1;
      expect(owned).toBe(4);
    });
  });
});
