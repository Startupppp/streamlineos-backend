import { sql, type SQL } from "drizzle-orm";

/**
 * Restricts an analytics query to the employees of one department.
 *
 * Deliberately a SEMI-JOIN (`IN (...)`) rather than an added `JOIN` to
 * hr_employments/hr_people: a join multiplies the outer row whenever a person
 * holds more than one live employment or more than one live person row — which
 * nothing in the schema currently prevents, since there is no partial unique
 * index on either — and would silently inflate every COUNT and SUM on this
 * screen. A semi-join matches at most once per outer row whatever the
 * cardinality underneath.
 *
 * Returns an empty fragment when no department is requested, so callers can
 * interpolate it unconditionally.
 *
 * `userColumn` must be a static SQL fragment naming the outer query's user
 * column (e.g. sql`lr.user_id`), never anything derived from request input.
 */
export function departmentMemberFilter(
  orgId: string,
  departmentId: string | undefined,
  userColumn: SQL,
): SQL {
  if (!departmentId) return sql``;
  return sql` AND ${userColumn} IN (
    SELECT p.user_id
      FROM hr_employments e
      JOIN hr_people p ON p.id = e.person_id AND p.org_id = e.org_id
     WHERE e.org_id = ${orgId}
       AND e.department_id = ${departmentId}
       AND e.deleted_at IS NULL
       AND p.deleted_at IS NULL
       AND p.user_id IS NOT NULL
  )`;
}
