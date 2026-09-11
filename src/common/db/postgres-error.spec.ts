import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DrizzleQueryError } from "drizzle-orm";
import {
  describeDatabaseCause,
  getPostgresErrorCode,
  getPostgresErrorDetails,
  isCheckViolation,
  isExclusionViolation,
  isForeignKeyViolation,
  isUniqueViolation,
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

describe("the five HR readers of uniq_hr_people_org_person_link", () => {
  /*
   * PINS A KNOWN GAP RATHER THAN ASSERTING CORRECTNESS.
   *
   * Reading `constraint_name` above was necessary but is NOT sufficient to wake
   * the five branches comparing against "uniq_hr_people_org_person_link"
   * (hr/core:170, hr/recruitment:140/163/178, hr/import:141). That index does
   * not exist in any applied schema:
   *
   *   - it is declared in Drizzle at `src/db/schema/hr/core-people.ts`, but
   *   - the only migration that CREATES it lives under `migrations/pending/
   *     hrms-phase1/`, which is absent from `meta/_journal.json`, so it has
   *     never run (the journalled 0486 adds a FOREIGN KEY, `fk_hr_people_org_
   *     person`, not this unique index).
   *
   * Measured on three databases at head (streamline_inv, inv_cold_head,
   * streamline_cold): the only uniques on hr_people are hr_people_pkey and
   * uniq_hr_people_org_id (org_id, id). Nothing constrains
   * (org_id, organization_person_id), so a second hr_people row pointing at the
   * same organization_person is ACCEPTED — 23505 is never raised and those five
   * branches cannot fire. Their sibling spec
   * (`hr/core/hr-people.service.spec.ts`) asserts the 409 over a hand-built
   * error, so it does not notice.
   *
   * Not fixed here: journalling that index is a live HR behaviour change that
   * fails while any org already holds a duplicate link, and HR is not this
   * branch's module. When it IS journalled, this test goes red — at which point
   * the five branches have genuinely come alive, and this block should be
   * deleted rather than adjusted.
   */
  const journalledTags = (
    JSON.parse(
      readFileSync(resolve(process.cwd(), "migrations", "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] }
  ).entries.map((entry) => entry.tag);

  const INDEX = "uniq_hr_people_org_person_link";

  it("is created by no journalled migration, so the branches stay unreachable", () => {
    const creators = journalledTags.filter((tag) => {
      const file = resolve(process.cwd(), "migrations", `${tag}.sql`);
      return existsSync(file) && readFileSync(file, "utf8").includes(INDEX);
    });

    expect(creators).toEqual([]);
  });

  it("is created only by the unjournalled hrms-phase1 migration", () => {
    const pending = resolve(
      process.cwd(),
      "migrations/pending/hrms-phase1/0000_hrms_profiles_workforce.sql",
    );

    expect(readFileSync(pending, "utf8")).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX}`);
    expect(journalledTags.filter((tag) => tag.includes("hrms_profiles_workforce"))).toEqual([]);
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
