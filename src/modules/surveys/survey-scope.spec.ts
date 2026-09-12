import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
import type { DataScope } from "../access/access.types";
import { ScopedRead } from "../access/scoped-read";
import { SurveyFormsService } from "./survey-forms.service";

/**
 * `surveys:view` is declared `scopable: true` and nothing applied the scope.
 *
 * An administrator could grant somebody `own`, the product accepted it, stored
 * it, and showed it back on the access screen — and every survey in the
 * organisation came back anyway. The inverse of an unreachable capability: a
 * requirement that exists and nothing satisfies it, which looks correct from
 * every angle except the data.
 *
 * Found by a census of scopable keys whose routes never resolve one. That census
 * had to be corrected twice before its numbers meant anything, so this entry was
 * verified by hand before it was believed.
 */

function dbWith(rows: readonly unknown[]) {
  const wheres: SQL[] = [];
  // `list` reads the page and its COUNT in one `Promise.all`, so the double has
  // to answer both — a missing `select` reads as a scope failure.
  const countChain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve([{ total: rows.length }]).then(resolve),
  };
  countChain["from"] = () => countChain;
  countChain["where"] = (where: SQL) => {
    wheres.push(where);
    return countChain;
  };
  return {
    wheres,
    db: {
      query: {
        surveyForms: {
          findMany: (args: { where: SQL }) => {
            wheres.push(args.where);
            return Promise.resolve(rows);
          },
          findFirst: (args: { where: SQL }) => {
            wheres.push(args.where);
            return Promise.resolve(rows[0]);
          },
        },
      },
      select: () => countChain,
    } as never,
  };
}

function serviceWith(db: unknown): SurveyFormsService {
  const stub = {} as never;
  return new SurveyFormsService(db as never, stub, stub, stub);
}

// The controller hands the service a ScopedRead; this is the same value with the
// scope the route would have resolved.
const readAs = (userId: string, scope: DataScope) => ScopedRead.of("org-1", userId, scope);

const sqlText = (statement: SQL): string => new PgDialect().sqlToQuery(statement).sql;
const FILTERS = { page: 1, pageSize: 20 } as never;

describe("surveys and the scope their permission declares", () => {
  it("narrows the list to what the caller created, at scope own", async () => {
    /*
     * The compiled predicate is the assertion. The fixture answers the same rows
     * whatever the WHERE says, so a count assertion would pass against the
     * unscoped version too.
     */
    const { db, wheres } = dbWith([]);
    await serviceWith(db).list(FILTERS, readAs("author-1", "own"));

    expect(sqlText(wheres[0] as SQL)).toContain('"created_by" =');
  });

  it("leaves a caller at scope all exactly as wide as they were", async () => {
    const { db, wheres } = dbWith([]);
    await serviceWith(db).list(FILTERS, readAs("admin-1", "all"));

    expect(sqlText(wheres[0] as SQL)).not.toContain('"created_by" =');
  });

  it("carries the tenant on the COUNT half as well as the page", async () => {
    // Two reads of the same table, so both are held to the same predicate — a
    // count that escaped the scope discloses how many rows the caller may not see.
    const { db, wheres } = dbWith([]);
    await serviceWith(db).list(FILTERS, readAs("author-1", "own"));

    expect(wheres).toHaveLength(2);
    for (const where of wheres) {
      expect(sqlText(where)).toContain('"org_id" =');
      expect(sqlText(where)).toContain('"created_by" =');
    }
  });

  it("scopes the one read that four mutations depend on", async () => {
    /*
     * `patch`, `publish`, `pause` and `close` each call `get` first as their
     * existence guard, so scoping `get` scopes all four. That is the leverage
     * here and it is worth pinning: a future mutation that loads the row itself
     * instead would quietly opt out.
     */
    const { db, wheres } = dbWith([]);
    const service = serviceWith(db);

    await expect(service.get(7, readAs("author-1", "own"))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(sqlText(wheres[0] as SQL)).toContain('"created_by" =');

    const source = readFileSync(join(__dirname, "survey-forms.service.ts"), "utf8");
    expect((source.match(/await this\.get\(surveyId, read\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
  });

  it("makes every survey unreachable at scope none", async () => {
    // `ScopedRead` refuses a denied read before it builds a predicate, so the
    // proof is that no statement reached the database and the page came back
    // empty — not a `WHERE false` the database still has to run.
    const { db, wheres } = dbWith([{ id: 1 }]);
    const result = await serviceWith(db).list(FILTERS, readAs("nobody-1", "none"));

    expect(wheres).toHaveLength(0);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("answers the detail read for a denied caller the way a missing survey is answered", async () => {
    const { db, wheres } = dbWith([{ id: 7 }]);

    await expect(serviceWith(db).get(7, readAs("nobody-1", "none"))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(wheres).toHaveLength(0);
  });
});
