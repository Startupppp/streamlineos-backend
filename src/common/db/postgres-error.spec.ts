import { DrizzleQueryError } from "drizzle-orm";
import {
  getPostgresErrorCode,
  getPostgresErrorDetails,
  isCheckViolation,
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
   * PINS A KNOWN GAP RATHER THAN ASSERTING CORRECTNESS.
   *
   * This repo drives postgres-js, which names the field `constraint_name`
   * (`node_modules/postgres/src/connection.js:46`, field code 110). The helper
   * reads `constraint`, which node-postgres uses and this driver never sends —
   * so `constraint` comes back undefined on every real failure, and the five
   * live branches comparing it to "uniq_hr_people_org_person_link" (hr/core,
   * hr/recruitment x3, hr/import) cannot fire.
   *
   * Not fixed here: every reader is inside HR, which this branch does not own.
   * The fix is to read `constraint ?? constraint_name`; when that lands, the
   * second expectation below flips to the constraint name and this comment goes.
   */
  it("does not yet read postgres-js's constraint_name", () => {
    const driverError = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint_name: "uniq_hr_people_org_person_link",
    });
    const error = new DrizzleQueryError("insert into hr_people ...", [], driverError);

    expect(getPostgresErrorDetails(error).code).toBe("23505");
    expect(getPostgresErrorDetails(error).constraint).toBeUndefined();
  });
});
