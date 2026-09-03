import { DrizzleQueryError } from "drizzle-orm";
import {
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
