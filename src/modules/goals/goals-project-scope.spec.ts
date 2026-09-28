import { PgDialect } from "drizzle-orm/pg-core";
import { goalsInManagedProductCondition } from "./goals-project-scope";

describe("goalsInManagedProductCondition", () => {
  it("qualifies the managed-product subquery with its own table alias", () => {
    const rendered = new PgDialect().sqlToQuery(
      goalsInManagedProductCondition("org-1", 7),
    );
    const sql = rendered.sql.replace(/\s+/g, " ");

    expect(sql).toContain(
      'SELECT "goal_projects"."id" FROM "build"."projects" AS "goal_projects"',
    );
    expect(sql).toContain('"goal_projects"."org_id"');
    expect(sql).toContain('"goal_projects"."managed_product_id"');
    expect(sql).toContain('"goal_projects"."deleted_at"');
    expect(sql).not.toContain(
      'SELECT "okrGoals"."id" FROM "build"."projects"',
    );
  });
});
