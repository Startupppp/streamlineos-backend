import { DrizzleQueryError } from "drizzle-orm";
import {
  describeDatabaseCause,
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

/**
 * The driver's account of a failure, which nothing was recording.
 *
 * A dead-lettered workflow run stored `error.stack`, and Drizzle wraps a driver
 * error in `DrizzleQueryError` whose message is `Failed query: <statement>`
 * followed by the bound parameters. So a failing 60-column insert wrote sixty
 * column names, sixty values, and no reason: the SQLSTATE, the constraint and
 * PostgreSQL's own sentence sit one level down on `.cause`, which nothing
 * walked. That is how a real dead-letter in `crm-whatsapp-ingress` came to name
 * the row it refused and never why.
 */
describe("describeDatabaseCause", () => {
  /**
   * The REAL wrapper, not a hand-built lookalike.
   *
   * Where `DrizzleQueryError` puts the driver error is the entire subject here,
   * so constructing an object that merely has a `cause` would test my belief
   * about the class rather than the class. The sibling tests above use it for
   * the same reason.
   */
  function wrapped(driver: Record<string, unknown>): Error {
    const inner = Object.assign(new Error(String(driver["message"] ?? "driver")), driver);
    return new DrizzleQueryError('insert into "business_parties" (...)', [], inner);
  }

  it("finds the SQLSTATE under the wrapper", () => {
    const text = describeDatabaseCause(
      wrapped({ code: "23503", message: 'insert or update on table "x" violates foreign key constraint "fk_y"' }),
    );
    expect(text).toContain("sqlstate 23503");
    expect(text).toContain("violates foreign key constraint");
  });

  it("reports postgres-js's constraint_name under the name `pg` uses", () => {
    /*
      The spelling trap this file already documents: postgres-js maps the
      server's `n` field to `constraint_name` and `pg` calls it `constraint`.
      An operator should not have to know which driver is installed.
    */
    const text = describeDatabaseCause(wrapped({ code: "23505", constraint_name: "uniq_thing" }));
    expect(text).toContain("constraint: uniq_thing");
    expect(text).not.toContain("constraint_name:");
  });

  it("never records `detail`, which carries the row rather than the fault", () => {
    /*
      PostgreSQL puts the offending values in `detail` -- `Key (email)=(a@b.c)
      already exists` -- and this string is PERSISTED to workflow_runs. The fault
      is what an operator needs; the row is not theirs to keep.
    */
    const text = describeDatabaseCause(
      wrapped({ code: "23505", detail: "Key (email)=(someone@example.com) already exists." }),
    );
    expect(text).toContain("sqlstate 23505");
    expect(text).not.toContain("someone@example.com");
  });

  it("is null for a failure with no driver error underneath", () => {
    /* So an ordinary error's text is left byte-for-byte as it was. */
    expect(describeDatabaseCause(new Error("just a bug"))).toBeNull();
    expect(describeDatabaseCause("a string")).toBeNull();
    expect(describeDatabaseCause(null)).toBeNull();
  });

  it("ignores a non-SQLSTATE `code`, which is how it knows the wrapper from the driver", () => {
    /*
      Node puts `code` on plenty of errors -- ECONNREFUSED, ERR_MODULE_NOT_FOUND.
      Matching five uppercase alphanumerics is what stops those being reported as
      a database fault.
    */
    expect(describeDatabaseCause(Object.assign(new Error("nope"), { code: "ECONNREFUSED" }))).toBeNull();
  });

  it("terminates on a cause chain that points at itself", () => {
    const loop: Record<string, unknown> = { message: "round" };
    loop["cause"] = loop;
    expect(describeDatabaseCause(loop)).toBeNull();
  });
});
