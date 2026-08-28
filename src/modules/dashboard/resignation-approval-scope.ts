import { sql, type SQL } from "drizzle-orm";
import { hrEmployments, hrPeople, hrReportingLines, resignations } from "../../db/schema";
import type { DataScope } from "../access/access.types";
import { applyScope } from "../access/apply-scope";

export function resignationApprovalScope(
  scope: DataScope,
  orgId: string,
  actorUserId: string,
): SQL {
  const canonicalDirectReport = sql`EXISTS (
    SELECT 1
    FROM ${hrReportingLines} rl
    INNER JOIN ${hrEmployments} me ON me.id = rl.manager_employment_id
      AND me.org_id = ${orgId} AND me.deleted_at IS NULL
    INNER JOIN ${hrPeople} mp ON mp.id = me.person_id
      AND mp.org_id = ${orgId} AND mp.deleted_at IS NULL AND mp.user_id = ${actorUserId}
    INNER JOIN ${hrEmployments} ee ON ee.id = rl.employment_id
      AND ee.org_id = ${orgId} AND ee.deleted_at IS NULL
    INNER JOIN ${hrPeople} ep ON ep.id = ee.person_id
      AND ep.org_id = ${orgId} AND ep.deleted_at IS NULL AND ep.user_id = ${resignations.userId}
    WHERE rl.org_id = ${orgId}
      AND rl.line_type = 'primary'
      AND rl.effective_to = 'infinity'::date
  )`;
  const derivedApprover = canonicalDirectReport;

  switch (scope) {
    case "all":
      return sql`true`;
    case "team": {
      const teammates = applyScope(scope, orgId, actorUserId, {
        ownerColumn: resignations.userId,
      });
      return sql`(${derivedApprover} AND ${teammates})`;
    }
    case "own":
      return derivedApprover;
    case "none":
      return sql`false`;
    default: {
      const _exhaustive: never = scope;
      return sql`false`;
    }
  }
}
