import { DrizzleQueryError } from "drizzle-orm";
import {
  describeDatabaseCause,
  getPostgresErrorCode,
  getPostgresErrorDetails,
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isNotNullViolation,
  isUndefinedTable,
  isUniqueViolation,
  isUniqueViolationOn,
} from "./postgres-error";

/**
 * Reproduces the error shape measured against postgres-js 3.4.9 and
 * drizzle-orm 0.45.2 on a real database: a `DrizzleQueryError` owning only
 * `stack, message, query, params, cause`, wrapping a `PostgresError` whose
 * fields are `constraint_name` / `table_name` / `column_name`. A fixture that
 * puts `code` on the outer error, or `constraint` on the inner one, is a shape
 * the driver never produces and proves nothing.
 */
function driverError(fields: Record<string, string>): Error {
  return Object.assign(new Error(fields.message ?? "driver error"), {
    name: "PostgresError",
    severity_local: "ERROR",
    severity: "ERROR",
    file: "nbtinsert.c",
    line: "666",
    routine: "_bt_check_unique",
    ...fields,
  });
}

function drizzleWrapped(fields: Record<string, string>): Error {
  return new DrizzleQueryError(
    'insert into "hr_people" ("org_id", "organization_person_id") values ($1, $2)',
    ["org-1", "person-1"],
    driverError(fields),
  );
}

const UNIQUE = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "uniq_hr_people_org_person_link"',
  detail: "Key (org_id, organization_person_id)=(org-1, person-1) already exists.",
  schema_name: "public",
  table_name: "hr_people",
  constraint_name: "uniq_hr_people_org_person_link",
};

describe("PostgreSQL error helpers", () => {
  describe("the shape drizzle actually throws", () => {
    const error = drizzleWrapped(UNIQUE);

    it("carries no code of its own and never names the SQLSTATE in its message", () => {
      expect(Object.getOwnPropertyNames(error).sort()).toEqual([
        "cause",
        "message",
        "params",
        "query",
        "stack",
      ]);
      expect(Reflect.get(error, "code")).toBeUndefined();
      expect(error.message).not.toContain("23505");
      expect(error.message).not.toContain("uniq_hr_people_org_person_link");
    });

    it("reads the SQLSTATE off the cause", () => {
      expect(getPostgresErrorDetails(error).code).toBe("23505");
      expect(isUniqueViolation(error)).toBe(true);
    });

    it("reads the constraint from constraint_name, which is what postgres-js sets", () => {
      expect(getPostgresErrorDetails(error)).toEqual({
        code: "23505",
        constraint: "uniq_hr_people_org_person_link",
        table: "hr_people",
        column: undefined,
        detail: "Key (org_id, organization_person_id)=(org-1, person-1) already exists.",
      });
    });

    it("matches a named constraint or unique index", () => {
      expect(isUniqueViolationOn(error, "uniq_hr_people_org_person_link")).toBe(true);
      expect(isUniqueViolationOn(error, "some_other_index")).toBe(false);
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

  it("still supports an unwrapped driver error through getPostgresErrorCode", () => {
    expect(getPostgresErrorCode({ code: "23505" })).toBe("23505");
  });

  describe("every integrity class the tree checks", () => {
    it("classifies foreign key, not-null, check, exclusion and undefined-table", () => {
      expect(isForeignKeyViolation(drizzleWrapped({ code: "23503" }))).toBe(true);
      expect(isNotNullViolation(drizzleWrapped({ code: "23502" }))).toBe(true);
      expect(isCheckViolation(drizzleWrapped({ code: "23514" }))).toBe(true);
      expect(isExclusionViolation(drizzleWrapped({ code: "23P01" }))).toBe(true);
      expect(isUndefinedTable(drizzleWrapped({ code: "42P01" }))).toBe(true);
      expect(isUniqueViolation(drizzleWrapped({ code: "23503" }))).toBe(false);
    });

    it("reads the column a not-null violation names", () => {
      const error = drizzleWrapped({
        code: "23502",
        table_name: "probe_child",
        column_name: "qty",
      });
      expect(getPostgresErrorDetails(error).column).toBe("qty");
    });
  });

  describe("shapes that are not a database error", () => {
    it("still supports an unwrapped driver error", () => {
      expect(getPostgresErrorDetails(driverError(UNIQUE)).code).toBe("23505");
      expect(getPostgresErrorDetails(driverError(UNIQUE)).constraint).toBe(
        "uniq_hr_people_org_person_link",
      );
    });

    it("accepts the node-postgres field names as well", () => {
      expect(
        getPostgresErrorDetails({ code: "23505", constraint: "pg_style", table: "t" }),
      ).toEqual({
        code: "23505",
        constraint: "pg_style",
        table: "t",
        column: undefined,
        detail: undefined,
      });
    });

    it("ignores a socket error's code, which is not a SQLSTATE", () => {
      const socket = new DrizzleQueryError("select 1", [], Object.assign(new Error("boom"), {
        code: "ECONNRESET",
      }));
      expect(getPostgresErrorDetails(socket).code).toBeUndefined();
      expect(isUniqueViolation(socket)).toBe(false);
    });

    it("stops safely for cyclic causes", () => {
      const error: { cause?: unknown } = {};
      error.cause = error;

      expect(getPostgresErrorDetails(error)).toEqual({});
      expect(getPostgresErrorDetails(error).code).toBeUndefined();
    });
  });
});

describe("the SQLSTATE predicates", () => {
  /*
   * These arrived as a second copy of the walk above, in `postgres-errors.ts` —
   * same directory, one letter apart — and a third private copy inside
   * `inv-product-crud.service.ts`. Both are gone; these cases exist so the
   * predicates keep answering over a real `DrizzleQueryError` rather than the
   * top frame, which is the mistake the whole file exists to stop.
   */
  const wrapped = (code: string): unknown =>
    new DrizzleQueryError("insert into ...", [], Object.assign(new Error("nope"), { code }));

  const wrapped23505 = (): object =>
    new DrizzleQueryError(
      "insert into ...",
      [],
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );

  it("sees a unique violation through Drizzle's wrapper", () => {
    expect(isUniqueViolation(wrapped("23505"))).toBe(true);
    expect(isUniqueViolation(wrapped("23503"))).toBe(false);
  });

  it("sees a foreign key violation through Drizzle's wrapper", () => {
    expect(isForeignKeyViolation(wrapped("23503"))).toBe(true);
  });

  it("sees a check violation through Drizzle's wrapper", () => {
    expect(isCheckViolation(wrapped("23514"))).toBe(true);
  });

  it("sees an exclusion violation through Drizzle's wrapper", () => {
    /*
     * 23P01, the one people forget. It is how overlapping ranges are rejected —
     * a dock appointment booked over another, a worker engagement overlapping an
     * existing one — so it most needs a 409 rather than a 500: the caller's next
     * move is a different time, not a retry.
     */
    expect(isExclusionViolation(wrapped("23P01"))).toBe(true);
    expect(isExclusionViolation(wrapped("23505"))).toBe(false);
  });

  it("is false rather than throwing for anything that is not a database error", () => {
    expect(isUniqueViolation(new Error("network"))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });

  /*
   * Carried over from `__tests__/postgres-errors.spec.ts`, which died with the
   * duplicate file. This is the assertion that states the defect rather than
   * just the fix: the naive `err.code === "23505"` reads UNDEFINED off the
   * wrapper, which is why 53 of the 63 files handling 23505 were catching
   * nothing at all.
   */
  it("shows why the naive check catches nothing", () => {
    const wrapped = wrapped23505();
    expect((wrapped as { code?: string }).code).toBeUndefined();
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("terminates on a self-referential cause rather than hanging", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isUniqueViolation(looped)).toBe(false);
  });
});

describe("the constraint name this driver actually sends", () => {
  /*
   * This repo drives postgres-js, which names the field `constraint_name`
   * (`node_modules/postgres/src/connection.js:46`, field code 110 — 'n');
   * `constraint` is node-postgres's spelling, which this driver never sends.
   * Confirmed against a real violation: the error's own enumerable keys are
   * code, constraint_name, detail, file, line, name, routine, schema_name,
   * severity, severity_local, table_name — no `constraint`. Until the walk read
   * both spellings, every caller comparing a constraint name compared undefined.
   */
  it("reads postgres-js's constraint_name", () => {
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: "uniq_hr_people_org_person_link",
    });
    const error = new DrizzleQueryError("insert into hr_people ...", [], driverError);

    expect(getPostgresErrorDetails(error)).toEqual({
      code: "23505",
      constraint: "uniq_hr_people_org_person_link",
    });
  });

  it("prefers node-postgres's spelling when a driver sends both", () => {
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "uniq_from_node_postgres",
      constraint_name: "uniq_from_postgres_js",
    });

    expect(getPostgresErrorDetails(driverError).constraint).toBe("uniq_from_node_postgres");
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
