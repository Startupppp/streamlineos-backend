/**
 * HRMS-E2E-015, attendance half.
 *
 * An attendance roster is not a headcount, so the answer is not automatic. It
 * turns on what the surface is for:
 *
 *  - The live team-status board and the period attendance summary are
 *    *observations of work*. Someone who has never followed their magic link
 *    cannot clock in, so they sit on the board as a permanent OFFLINE row and
 *    enter the summary with a row of zeroes — read as absence, which it is not.
 *    Both exclude them.
 *  - The attendance-rate denominator on the dashboard has the same problem one
 *    level up: dividing by a body count that includes people who cannot check
 *    in drives the rate down without anyone having missed a day.
 *  - The summary's explicit-`userIds` branch is deliberately left counting
 *    them. There the caller has *named* the person; answering an explicit
 *    lookup with silence is worse than answering it with zeroes.
 *
 * These assert on the predicate each query sends, rendered, because the
 * in-memory SQL evaluator cannot drive `selectDistinctOn` with a lateral
 * subquery or the summary's window arithmetic.
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { AttendancePolicyService } from "./attendance-policy.service";
import { ATTENDANCE_PERMISSION } from "./attendance-scope";
import { AttendanceSummaryService } from "./attendance-summary.service";
import { AttendanceService } from "./attendance.service";
import { buildAttendanceAnalytics } from "../lifecycle/hr-dashboard-attendance";
import { HrDashboardReportsService } from "../lifecycle/hr-dashboard-reports.service";
import { CacheService } from "../../../common/cache/cache.service";
import { InMemoryRedis } from "../../../common/cache/in-memory-redis.test-double";
import type { Redis } from "@upstash/redis";

const ORG = "org-1";
const dialect = new PgDialect();

const ACCEPTANCE = `"email_verified" is not null`;

/**
 * Every builder method returns the chain, `where` records its predicate, and
 * awaiting yields no rows — enough to walk a query to the point where it has
 * declared what it filters on.
 */
function capturingDb(): { db: Db; captured: (SQL | undefined)[] } {
  const captured: (SQL | undefined)[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of [
    "from",
    "innerJoin",
    "leftJoin",
    "groupBy",
    "orderBy",
    "limit",
    "offset",
    "as",
  ])
    chain[method] = () => chain;
  chain["where"] = (predicate?: SQL) => {
    captured.push(predicate);
    return chain;
  };
  chain["then"] = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
  const db = { select: () => chain, selectDistinctOn: () => chain };
  return { db: db as unknown as Db, captured };
}

function rendered(predicate: SQL | undefined): string {
  return predicate === undefined ? "" : dialect.sqlToQuery(predicate).sql;
}

function policyDouble(): AttendancePolicyService {
  return {} as unknown as AttendancePolicyService;
}

function accessDouble(): AccessService {
  return {} as unknown as AccessService;
}

function unrestrictedAccessDouble(): AccessService {
  const double = {
    resolveUserPermissions: () => Promise.resolve(new Map([[ATTENDANCE_PERMISSION, "all"]])),
  };
  return double as unknown as AccessService;
}

function currentUser(): CurrentUserContext {
  const user = { orgId: ORG, userId: "u-admin", membershipId: 1 };
  return user as unknown as CurrentUserContext;
}

describe("attendance rosters and the attendance-rate denominator", () => {
  it("filters the period summary roster on acceptance", async () => {
    const { db, captured } = capturingDb();
    const service = new AttendanceSummaryService(db, policyDouble(), accessDouble());

    await service
      .buildAttendanceSummary({ orgId: ORG, periodStart: "2026-09-01", periodEnd: "2026-09-30" })
      .catch(() => undefined);

    const rosterPredicates = captured.filter((predicate) => rendered(predicate).includes(`"users"."is_active"`));
    expect(rosterPredicates.length).toBeGreaterThan(0);
    for (const predicate of rosterPredicates) expect(rendered(predicate)).toContain(ACCEPTANCE);
  });

  it("does NOT filter an explicitly named set of users on acceptance", async () => {
    const { db, captured } = capturingDb();
    const service = new AttendanceSummaryService(db, policyDouble(), accessDouble());

    await service
      .buildAttendanceSummary({
        orgId: ORG,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-30",
        userIds: ["u-pending"],
      })
      .catch(() => undefined);

    const rosterPredicates = captured.filter((predicate) => rendered(predicate).includes(`"users"."is_active"`));
    expect(rosterPredicates.length).toBeGreaterThan(0);
    for (const predicate of rosterPredicates) expect(rendered(predicate)).not.toContain(ACCEPTANCE);
  });

  it("filters the live team-status board on acceptance", async () => {
    const { db, captured } = capturingDb();
    const service = new AttendanceService(
      db,
      unrestrictedAccessDouble(),
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    await service.teamStatus(currentUser(), { limit: 50 }).catch(() => undefined);

    const rosterPredicates = captured.filter((predicate) => rendered(predicate).includes(`"users"."is_active"`));
    expect(rosterPredicates.length).toBeGreaterThan(0);
    for (const predicate of rosterPredicates) expect(rendered(predicate)).toContain(ACCEPTANCE);
  });

  it("filters the dashboard attendance-rate denominator on acceptance", async () => {
    const { db, captured } = capturingDb();

    await buildAttendanceAnalytics(db, ORG).catch(() => undefined);

    const denominators = captured.filter((predicate) => rendered(predicate).includes(`"users"."is_active"`));
    expect(denominators.length).toBeGreaterThan(0);
    for (const predicate of denominators) expect(rendered(predicate)).toContain(ACCEPTANCE);
  });

  it("filters the headcount trend on acceptance", async () => {
    const { db, captured } = capturingDb();
    const cache = new CacheService(new InMemoryRedis() as unknown as Redis);

    await new HrDashboardReportsService(db, cache).headcountTrends(ORG).catch(() => undefined);

    const trend = captured.filter((predicate) => rendered(predicate).includes(`"users"."is_active"`));
    expect(trend.length).toBeGreaterThan(0);
    for (const predicate of trend) expect(rendered(predicate)).toContain(ACCEPTANCE);
  });
});
