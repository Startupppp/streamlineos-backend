import type { ParamValue } from "../emit";
import { QueryCompilationError } from "../errors";
import { QUERY_LIMITS, type FieldType } from "../query-description";

/**
 * A value has to be the shape its column is.
 *
 * This is not about injection — a wrong-typed value is still a bind parameter
 * and still cannot become SQL. It is about the failure that happens instead: a
 * string where a number belongs reaches Postgres as `numeric` and raises a
 * *runtime* error inside the tenant's transaction, so the report fails when it
 * runs rather than when it is written. Checking here turns that into a 400 at
 * the moment of authoring.
 *
 * Timestamps and dates arrive as strings because JSON has no date. They are
 * checked for parseability, not reformatted — Postgres understands ISO 8601 and
 * the string is bound with an explicit cast, so there is nothing to normalise.
 */
export function checkValue(value: unknown, type: FieldType, path: string): ParamValue {
  const mismatch = (expected: string): never => {
    throw new QueryCompilationError(
      "value_type_mismatch",
      `expected ${expected} for a ${type} field`,
      path,
    );
  };

  switch (type) {
    /**
     * Grouped with `text`: an enum value crosses the wire as a string and
     * Postgres infers the enum type from the column it is compared against. A
     * value naming no member of the enum is an error there, not here — this
     * compiler does not know the members, and inventing a second list of them
     * would be a second thing to keep in step with the database.
     */
    case "enum":
    case "text":
      if (typeof value !== "string") return mismatch("a string");
      /**
       * Postgres `text` cannot hold a NUL byte, so `postgres-js` raises on one
       * rather than sending it. Left unchecked, a filter value with an embedded
       * NUL becomes a driver exception inside the tenant's transaction — a 500
       * on what is plainly a bad request. Refusing here makes it a 400.
       *
       * It is not an injection: a NUL in a bind parameter is as inert as any
       * other byte. It is in the enumeration because it is the one value shape
       * the layers below this one cannot represent.
       */
      if (value.includes("\u0000")) return mismatch("a string without NUL bytes");
      if (value.length > QUERY_LIMITS.maxValueLength)
        throw new QueryCompilationError(
          "limit_exceeded",
          `text values may not exceed ${QUERY_LIMITS.maxValueLength} characters`,
          path,
        );
      return value;
    case "number":
      /**
       * `Number.isFinite` and not `typeof === "number"`: `NaN` and the
       * infinities are numbers, and `numeric` accepts `NaN`, where it compares
       * greater than everything. A filter of `value_minor < NaN` returning the
       * whole table is not a result anybody would question.
       */
      if (typeof value !== "number" || !Number.isFinite(value)) return mismatch("a finite number");
      return value;
    case "boolean":
      if (typeof value !== "boolean") return mismatch("a boolean");
      return value;
    case "timestamp":
    case "date": {
      if (typeof value !== "string") return mismatch("an ISO 8601 string");
      if (value.length > 40 || Number.isNaN(Date.parse(value)))
        return mismatch("a parseable ISO 8601 string");
      return value;
    }
  }
}
