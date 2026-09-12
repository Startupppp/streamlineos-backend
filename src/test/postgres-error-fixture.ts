import { DrizzleQueryError } from "drizzle-orm";

/**
 * A database error in the shape this deployment actually throws, for specs of
 * the branches that translate one into an HTTP answer.
 *
 * postgres-js builds a `PostgresError` by `Object.assign`-ing the server's
 * fields onto an `Error`, so the SQLSTATE sits on `code` and the constraint on
 * `constraint_name` (not `constraint`, which is node-postgres's spelling).
 * Drizzle then wraps it: every failure on the postgres-js session path is
 * rethrown as a `DrizzleQueryError` with the driver error on `.cause`
 * (`drizzle-orm/pg-core/session.js`, `queryWithCache`). The wrapper has no
 * `code` of its own.
 *
 * Specs used to reject with a bare `{ code: "23505" }`, a shape drizzle never
 * produces. It satisfied `err.code === "23505"`, so conflict branches that
 * could not fire in production passed their tests; build the error here
 * instead.
 */
export function drizzlePostgresError(
  code: string,
  constraint?: string,
  message = "database error",
): DrizzleQueryError {
  const driverError = Object.assign(new Error(message), {
    name: "PostgresError",
    severity: "ERROR",
    code,
    ...(constraint === undefined ? {} : { constraint_name: constraint }),
  });
  return new DrizzleQueryError("insert into ...", [], driverError);
}

/** 23505 as it reaches a service: a unique violation behind Drizzle's wrapper. */
export function drizzleUniqueViolation(constraint?: string): DrizzleQueryError {
  return drizzlePostgresError(
    "23505",
    constraint,
    `duplicate key value violates unique constraint "${constraint ?? "unknown"}"`,
  );
}
