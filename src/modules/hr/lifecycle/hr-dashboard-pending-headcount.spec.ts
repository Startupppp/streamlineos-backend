/**
 * HRMS-E2E-015, dashboard half — see `hr-analytics-pending-headcount.spec.ts`
 * for why `users.is_active` alone is the wrong predicate for headcount.
 *
 * The three numbers here are the ones on the HR landing page: the active
 * headcount card, the diversity breakdown beside it, and the headcount-by
 * grouping the org structure screen draws. All three divided or grouped a
 * population that included an invitation nobody had opened.
 */

import type { Redis } from "@upstash/redis";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { CacheService } from "../../../common/cache/cache.service";
import { InMemoryRedis } from "../../../common/cache/in-memory-redis.test-double";
import type { Db } from "../../../db/drizzle.module";
import { makeFakeDb, type TableRows } from "../../../test/fake-select-db";
import { OrgStructureService } from "../directory/org-structure.service";
import { HrDashboardService } from "./hr-dashboard.service";

const ORG = "org-1";

function orgRows(): TableRows {
  return {
    organization_members: [
      { id: 1, org_id: ORG, user_id: "u-accepted", role: "EMPLOYEE", status: "ACTIVE" },
      { id: 2, org_id: ORG, user_id: "u-pending", role: "EMPLOYEE", status: "ACTIVE" },
    ],
    users: [
      {
        id: "u-accepted",
        is_active: true,
        email_verified: new Date("2026-01-02T00:00:00.000Z"),
        gender: "FEMALE",
        date_of_birth: null,
      },
      { id: "u-pending", is_active: true, email_verified: null, gender: "MALE", date_of_birth: null },
    ],
  };
}

function cache(): CacheService {
  return new CacheService(new InMemoryRedis() as unknown as Redis);
}

describe("HR dashboard headcount excludes an invitation nobody accepted", () => {
  /**
   * The active-employees card cannot be driven through the in-memory SQL
   * evaluator: `buildMetrics` also runs the upcoming-birthdays query, whose
   * `to_char(...) IN (...)` window the evaluator cannot tokenize, and it throws
   * before any number comes back. So this one asserts on the predicate the
   * service actually sends for that count, rendered. The negative control is
   * the total-employees count in the same batch, which deliberately still
   * counts everyone — if the two rendered the same, this would prove nothing.
   */
  it("sends the acceptance predicate for the active-employees card and not for the total", async () => {
    const captured: (SQL | undefined)[] = [];
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "leftJoin", "groupBy", "orderBy", "limit"])
      chain[method] = () => chain;
    chain["where"] = (predicate?: SQL) => {
      captured.push(predicate);
      return chain;
    };
    chain["then"] = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    const db = { select: () => chain } as unknown as Db;

    await new HrDashboardService(db, cache()).metrics(ORG).catch(() => undefined);

    const dialect = new PgDialect();
    const total = captured[0];
    const active = captured[1];
    expect(total).toBeDefined();
    expect(active).toBeDefined();
    if (total === undefined || active === undefined) return;
    expect(dialect.sqlToQuery(active).sql).toContain(`"email_verified" is not null`);
    expect(dialect.sqlToQuery(total).sql).not.toContain(`"email_verified"`);
  });

  it("leaves the pending invitee out of the diversity gender breakdown", async () => {
    const service = new HrDashboardService(makeFakeDb(orgRows()) as unknown as Db, cache());

    const { genderBreakdown } = await service.diversity(ORG);

    const distributed = genderBreakdown.reduce((sum, row) => sum + row.count, 0);
    expect(distributed).toBe(1);
  });

  it("leaves the pending invitee out of headcount grouped by role", async () => {
    const service = new OrgStructureService(
      makeFakeDb(orgRows()) as unknown as Db,
      cache(),
      undefined as never,
      undefined as never,
    );

    const groups = await service.getHeadcount(ORG, { groupBy: "role" });

    const distributed = groups.reduce((sum, group) => sum + group.count, 0);
    expect(distributed).toBe(1);
  });

  it("leaves the pending invitee out of headcount grouped by department", async () => {
    const service = new OrgStructureService(
      makeFakeDb(orgRows()) as unknown as Db,
      cache(),
      undefined as never,
      undefined as never,
    );

    const groups = await service.getHeadcount(ORG, { groupBy: "department" });

    const distributed = groups.reduce((sum, group) => sum + group.count, 0);
    expect(distributed).toBe(1);
  });

  it("leaves the pending invitee out of headcount grouped by branch", async () => {
    const service = new OrgStructureService(
      makeFakeDb(orgRows()) as unknown as Db,
      cache(),
      undefined as never,
      undefined as never,
    );

    const groups = await service.getHeadcount(ORG, { groupBy: "branch" });

    const distributed = groups.reduce((sum, group) => sum + group.count, 0);
    expect(distributed).toBe(1);
  });
});
