import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { NotFoundException } from "@nestjs/common";
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
    } as never,
  };
}

function serviceWith(db: unknown): SurveyFormsService {
  const stub = {} as never;
  return new SurveyFormsService(db as never, stub, stub, stub);
}

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
    await serviceWith(db).list("org-1", "author-1", FILTERS, "own");

    expect(sqlText(wheres[0] as SQL)).toContain('"created_by" =');
  });

  it("leaves a caller at scope all exactly as wide as they were", async () => {
    const { db, wheres } = dbWith([]);
    await serviceWith(db).list("org-1", "admin-1", FILTERS, "all");

    expect(sqlText(wheres[0] as SQL)).not.toContain('"created_by" =');
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

    await expect(service.get("org-1", "author-1", 7, "own")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(sqlText(wheres[0] as SQL)).toContain('"created_by" =');

    const source = readFileSync(join(__dirname, "survey-forms.service.ts"), "utf8");
    expect((source.match(/await this\.get\(orgId, userId, surveyId, scope\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
  });

  it("makes every survey unreachable at scope none", async () => {
    const { db, wheres } = dbWith([]);
    await serviceWith(db).list("org-1", "nobody-1", FILTERS, "none");

    expect(sqlText(wheres[0] as SQL)).toContain("false");
  });
});
