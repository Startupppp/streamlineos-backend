import { DrizzleQueryError } from "drizzle-orm";
import {
  getPostgresErrorCode,
  getPostgresErrorDetails,
} from "./postgres-error";

describe("PostgreSQL error helpers", () => {
  it("reads SQLSTATE and constraint from a Drizzle cause", () => {
    const driverError = Object.assign(new Error("conflicting key"), {
      code: "23P01",
      constraint: "excl_worker_engagements_overlap",
    });
    const error = new DrizzleQueryError("insert into ...", [], driverError);

    expect(getPostgresErrorDetails(error)).toEqual({
      code: "23P01",
      constraint: "excl_worker_engagements_overlap",
    });
  });

  /**
   * The field names above are `pg`'s. This repo connects through postgres-js,
   * which spells the same field `constraint_name` — see `errorFields` in
   * `postgres/src/connection.js`, where the server's `n` field is mapped. A
   * helper that reads only `constraint` therefore answered `undefined` for
   * every error this deployment can actually raise, and the test above could
   * not see it because it fabricated the field it was looking for.
   */
  it("reads the constraint name postgres-js actually sets", () => {
    const driverError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "uniq_crm_pricebooks_org_name"',
      ),
      {
        code: "23505",
        constraint_name: "uniq_crm_pricebooks_org_name",
        severity: "ERROR",
      },
    );
    const error = new DrizzleQueryError("insert into ...", [], driverError);

    expect(getPostgresErrorDetails(error)).toEqual({
      code: "23505",
      constraint: "uniq_crm_pricebooks_org_name",
    });
  });

  it("still supports an unwrapped driver error", () => {
    expect(getPostgresErrorCode({ code: "23505" })).toBe("23505");
  });

  it("stops safely for cyclic causes", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;

    expect(getPostgresErrorDetails(error)).toEqual({
      code: undefined,
      constraint: undefined,
    });
  });
});
